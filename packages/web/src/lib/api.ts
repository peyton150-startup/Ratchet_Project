import {
  RatchetClient,
  TASK_FIELDS,
  type EventInput,
  type IngestResult,
  type Task,
  type TaskAction,
  type TaskFilter,
} from '@workspace/sdk';
import { createClient, type Client as WsClient } from 'graphql-ws';

/** State of the live-updates socket, as the operator console's badge reports it. */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface EventSummary {
  id: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  delta: Record<string, unknown>;
}

/** Turn whatever graphql-ws hands the error sink (GraphQL errors, a CloseEvent, an Error) into text. */
function describeSubscriptionError(err: unknown): string {
  if (Array.isArray(err)) return (err[0] as { message?: string } | undefined)?.message ?? 'subscription failed';
  if (err instanceof Error) return err.message;
  const code = (err as { code?: number } | null)?.code;
  return code ? `live updates disconnected (code ${code})` : 'live updates disconnected';
}

export interface ConsoleApiOptions {
  baseUrl?: string;
  apiKey: string;
}

export interface RuleVersion {
  ruleKey: string;
  version: number;
  trigger: unknown;
  condition: unknown;
  action: unknown;
  active: boolean;
  createdAt: string;
}

/**
 * Console-facing API: REST/GraphQL via the published SDK, plus a graphql-ws subscription for live
 * queue updates. Deliberately thin — the SDK is the single definition of the surface, so the
 * console cannot drift from what integrators use.
 */
export class ConsoleApi {
  readonly client: RatchetClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private ws: WsClient | null = null;
  private status: ConnectionStatus = 'connecting';
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();

  constructor(opts: ConsoleApiOptions) {
    this.baseUrl = (opts.baseUrl ?? window.location.origin).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.client = new RatchetClient({ baseUrl: this.baseUrl, apiKey: this.apiKey });
  }

  tasks(filter: TaskFilter = {}): Promise<Task[]> {
    return this.client.tasks(filter);
  }

  queues() {
    return this.client.graphql<{ queues: Array<{ name: string; strategy: string; active: boolean }> }>(
      '{ queues { name strategy active } }',
    ).then((d) => d.queues);
  }

  /** Run a state-machine action. Every action has a `<action>Task` method on the SDK client. */
  act(action: TaskAction, id: string): Promise<Task> {
    return this.client[`${action}Task`](id);
  }

  /** Post an event to the ingest API, as a client system would. Needs events:ingest. */
  ingest(event: EventInput): Promise<IngestResult> {
    return this.client.ingest(event);
  }

  /** All stored rule versions (including superseded) — the admin console's history + diffs. */
  rules(): Promise<RuleVersion[]> {
    return this.client
      .graphql<{ rules: RuleVersion[] }>(
        '{ rules { ruleKey version trigger condition action active createdAt } }',
      )
      .then((d) => d.rules);
  }

  /** Publish the next version of a rule. */
  createRuleVersion(draft: {
    ruleKey: string;
    trigger: unknown;
    condition: unknown;
    action: unknown;
  }): Promise<RuleVersion> {
    return this.client
      .graphql<{ createRuleVersion: RuleVersion }>(
        `mutation($input: RuleVersionInput!) {
           createRuleVersion(input: $input) { ruleKey version trigger condition action active createdAt }
         }`,
        {
          input: {
            ruleKey: draft.ruleKey,
            trigger: draft.trigger,
            condition: draft.condition,
            action: draft.action,
          },
        },
      )
      .then((d) => d.createRuleVersion);
  }

  /** Evaluate a draft rule against a sample event without persisting anything. */
  dryRunRule(rule: unknown, event: unknown): Promise<{ matched: boolean; decision: unknown }> {
    return this.client
      .graphql<{ dryRunRule: { matched: boolean; decision: unknown } }>(
        'mutation($rule: JSON!, $event: JSON!) { dryRunRule(rule: $rule, event: $event) { matched decision } }',
        // The API validates a complete rule; drafts carry no version until published.
        { rule: { ...(rule as Record<string, unknown>), version: 1 }, event },
      )
      .then((d) => d.dryRunRule);
  }

  /** Event history for a task's subject entity — the "task detail with event history" view. */
  events(entityId: string): Promise<EventSummary[]> {
    return this.client
      .graphql<{ events: EventSummary[] }>(
        'query($entityId: String!) { events(entityId: $entityId) { id type occurredAt payload delta } }',
        { entityId },
      )
      .then((d) => d.events);
  }

  /** Report the socket's state now and on every change. Returns an unsubscribe function. */
  onConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  /**
   * Subscribe to live task changes. Returns an unsubscribe function. `onError` receives anything
   * that stops the feed: a rejected subscription (a key without tasks:read) or a lost connection.
   */
  subscribeToQueue(
    queue: string | undefined,
    onTask: (task: Task) => void,
    onError?: (message: string) => void,
  ): () => void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/graphql';
    this.ws ??= createClient({
      url: wsUrl,
      connectionParams: { authorization: `Bearer ${this.apiKey}` },
      // Changing the queue filter unsubscribes and resubscribes; without a grace period the lazy
      // client drops the socket in between and the badge flickers through "reconnecting".
      lazyCloseTimeout: 5000,
      on: {
        connecting: (isRetry) => this.setStatus(isRetry ? 'reconnecting' : 'connecting'),
        connected: () => this.setStatus('live'),
        // The retry starts after a backoff delay; say so now rather than showing "live" meanwhile.
        closed: () => {
          if (this.status === 'live') this.setStatus('reconnecting');
        },
      },
    });

    return this.ws.subscribe<{ queueUpdated: Task }>(
      {
        query: `subscription($queue: String) { queueUpdated(queue: $queue) { ${TASK_FIELDS} } }`,
        variables: { queue: queue ?? null },
      },
      {
        next: (msg) => {
          if (msg.errors?.length) onError?.(describeSubscriptionError(msg.errors));
          if (msg.data?.queueUpdated) onTask(msg.data.queueUpdated);
        },
        error: (err) => {
          // GraphQL errors leave the socket up; anything else means the client gave up retrying.
          if (!Array.isArray(err)) this.setStatus('offline');
          onError?.(describeSubscriptionError(err));
        },
        complete: () => {},
      },
    );
  }

  dispose(): void {
    this.ws?.dispose();
    this.ws = null;
  }
}
