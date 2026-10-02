import {
  RatchetError,
  transitionTarget,
  type EventInput,
  type Task,
  type TaskAction,
  type TaskFilter,
} from '@workspace/sdk';
import type { ConnectionStatus, ConsoleApi, EventSummary, RuleVersion } from '../src/lib/api';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    ruleKey: 'R1',
    ruleVersion: 1,
    queue: 'intake',
    template: 'Initial completeness check',
    priority: 0,
    state: 'open',
    assignee: null,
    assigneeName: null,
    slaDueAt: null,
    subject: { entityId: 'app-1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export interface StubOptions {
  tasks?: Task[];
  queues?: string[];
  rules?: RuleVersion[];
  events?: EventSummary[];
  /** Make ingest fail the way the API would, e.g. { status: 403, message: 'forbidden' }. */
  ingestError?: { status: number; message: string };
  /** Make reading rules fail, as it does for a key without rules:read. */
  rulesForbidden?: boolean;
}

export interface StubApi {
  api: ConsoleApi;
  calls: {
    act: Array<{ action: string; id: string }>;
    created: unknown[];
    dryRuns: unknown[];
    dryRunEvents: unknown[];
    taskFilters: TaskFilter[];
    ingested: EventInput[];
  };
  /** Push a task through the subscription, as the server would. */
  pushUpdate: (task: Task) => void;
  /** Move the live-updates socket to a new state, as graphql-ws would report it. */
  setConnection: (status: ConnectionStatus) => void;
  /** Fail the subscription, as a rejected key or a dropped socket would. */
  failSubscription: (message: string) => void;
}

/**
 * A stub standing in for ConsoleApi. Component tests drive real components against this instead of
 * a live server, so they assert on rendering and interaction, not transport.
 */
export function stubApi(opts: StubOptions = {}): StubApi {
  const calls: StubApi['calls'] = {
    act: [],
    created: [],
    dryRuns: [],
    dryRunEvents: [],
    taskFilters: [],
    ingested: [],
  };
  const seenKeys = new Map<string, string>();
  let subscriber: ((t: Task) => void) | null = null;
  let subscriptionError: ((message: string) => void) | null = null;
  let statusListener: ((s: ConnectionStatus) => void) | null = null;
  let tasks = opts.tasks ?? [];

  const api = {
    tasks: async (filter: TaskFilter = {}) => {
      calls.taskFilters.push(filter);
      return tasks;
    },
    queues: async () => (opts.queues ?? ['intake']).map((name) => ({ name, strategy: 'round_robin', active: true })),
    act: async (action: TaskAction, id: string) => {
      calls.act.push({ action, id });
      const current = tasks.find((t) => t.id === id)!;
      // The shared transition table, so the stub cannot accept what the server would reject.
      const nextState = transitionTarget(current.state, action);
      if (nextState === null) throw new Error(`illegal transition from ${current.state}: ${action}`);
      const updated = { ...current, state: nextState };
      tasks = tasks.map((t) => (t.id === id ? updated : t));
      return updated;
    },
    events: async () => opts.events ?? [],
    onConnectionStatus: (listener: (s: ConnectionStatus) => void) => {
      statusListener = listener;
      listener('connecting');
      return () => {
        statusListener = null;
      };
    },
    rules: async () => {
      if (opts.rulesForbidden) throw new RatchetError('forbidden', 200);
      return opts.rules ?? [];
    },
    ingest: async (event: EventInput) => {
      calls.ingested.push(event);
      if (opts.ingestError) throw new RatchetError(opts.ingestError.message, opts.ingestError.status);
      // Exactly-once, as the API does it: a repeated idempotency key returns the first event's id.
      const existing = seenKeys.get(event.idempotencyKey);
      if (existing) return { eventId: existing, duplicate: true };
      const eventId = `evt-${seenKeys.size + 1}`;
      seenKeys.set(event.idempotencyKey, eventId);
      return { eventId, duplicate: false };
    },
    createRuleVersion: async (draft: { ruleKey: string }) => {
      calls.created.push(draft);
      const version = (opts.rules ?? []).filter((r) => r.ruleKey === draft.ruleKey).length + 1;
      return { ...draft, version, trigger: {}, condition: null, action: {}, active: true, createdAt: '' };
    },
    dryRunRule: async (rule: unknown, event: unknown) => {
      calls.dryRuns.push(rule);
      calls.dryRunEvents.push(event);
      return { matched: true, decision: { ruleKey: 'R1' } };
    },
    subscribeToQueue: (
      _queue: string | undefined,
      onTask: (t: Task) => void,
      onError?: (message: string) => void,
    ) => {
      subscriber = onTask;
      subscriptionError = onError ?? null;
      return () => {
        subscriber = null;
        subscriptionError = null;
      };
    },
    dispose: () => {},
  } as unknown as ConsoleApi;

  return {
    api,
    calls,
    pushUpdate: (t) => subscriber?.(t),
    setConnection: (status) => statusListener?.(status),
    failSubscription: (message) => subscriptionError?.(message),
  };
}
