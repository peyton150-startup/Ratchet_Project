import type { Task } from '@workspace/sdk';
import type { ConsoleApi, RuleVersion } from '../src/lib/api';

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
}

export interface StubApi {
  api: ConsoleApi;
  calls: { act: Array<{ action: string; id: string }>; created: unknown[]; dryRuns: unknown[] };
  /** Push a task through the subscription, as the server would. */
  pushUpdate: (task: Task) => void;
}

/**
 * A stub standing in for ConsoleApi. Component tests drive real components against this instead of
 * a live server, so they assert on rendering and interaction, not transport.
 */
export function stubApi(opts: StubOptions = {}): StubApi {
  const calls: StubApi['calls'] = { act: [], created: [], dryRuns: [] };
  let subscriber: ((t: Task) => void) | null = null;
  let tasks = opts.tasks ?? [];

  const api = {
    tasks: async () => tasks,
    queues: async () => (opts.queues ?? ['intake']).map((name) => ({ name, strategy: 'round_robin', active: true })),
    act: async (action: 'claim' | 'complete' | 'block', id: string) => {
      calls.act.push({ action, id });
      const nextState = action === 'claim' ? 'claimed' : action === 'complete' ? 'completed' : 'blocked';
      const updated = { ...tasks.find((t) => t.id === id)!, state: nextState };
      tasks = tasks.map((t) => (t.id === id ? updated : t));
      return updated;
    },
    events: async () => [],
    rules: async () => opts.rules ?? [],
    createRuleVersion: async (draft: unknown) => {
      calls.created.push(draft);
      return { ruleKey: 'R1', version: 1, trigger: {}, condition: null, action: {}, active: true, createdAt: '' };
    },
    dryRunRule: async (rule: unknown) => {
      calls.dryRuns.push(rule);
      return { matched: true, decision: { ruleKey: 'R1' } };
    },
    subscribeToQueue: (_queue: string | undefined, onTask: (t: Task) => void) => {
      subscriber = onTask;
      return () => {
        subscriber = null;
      };
    },
    dispose: () => {},
  } as unknown as ConsoleApi;

  return { api, calls, pushUpdate: (t) => subscriber?.(t) };
}
