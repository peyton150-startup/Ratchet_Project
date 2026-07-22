import { RatchetClient, type Task } from '@workspace/sdk';
import { createClient, type Client as WsClient } from 'graphql-ws';

const TASK_FIELDS =
  'id ruleKey ruleVersion queue template priority state assignee slaDueAt subject createdAt updatedAt';

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

  constructor(opts: ConsoleApiOptions) {
    this.baseUrl = (opts.baseUrl ?? window.location.origin).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.client = new RatchetClient({ baseUrl: this.baseUrl, apiKey: this.apiKey });
  }

  tasks(filter: { queue?: string; state?: string } = {}): Promise<Task[]> {
    return this.client.tasks(filter);
  }

  queues() {
    return this.client.graphql<{ queues: Array<{ name: string; strategy: string; active: boolean }> }>(
      '{ queues { name strategy active } }',
    ).then((d) => d.queues);
  }

  act(action: 'claim' | 'complete' | 'block', id: string): Promise<Task> {
    if (action === 'claim') return this.client.claimTask(id);
    if (action === 'complete') return this.client.completeTask(id);
    return this.client.blockTask(id);
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
  events(entityId: string): Promise<Array<{ id: string; type: string; occurredAt: string }>> {
    return this.client
      .graphql<{ events: Array<{ id: string; type: string; occurredAt: string }> }>(
        'query($entityId: String!) { events(entityId: $entityId) { id type occurredAt } }',
        { entityId },
      )
      .then((d) => d.events);
  }

  /** Subscribe to live task changes. Returns an unsubscribe function. */
  subscribeToQueue(queue: string | undefined, onTask: (task: Task) => void): () => void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/graphql';
    this.ws ??= createClient({
      url: wsUrl,
      connectionParams: { authorization: `Bearer ${this.apiKey}` },
    });

    return this.ws.subscribe<{ queueUpdated: Task }>(
      {
        query: `subscription($queue: String) { queueUpdated(queue: $queue) { ${TASK_FIELDS} } }`,
        variables: { queue: queue ?? null },
      },
      {
        next: (msg) => {
          if (msg.data?.queueUpdated) onTask(msg.data.queueUpdated);
        },
        error: (err) => console.error('subscription error', err),
        complete: () => {},
      },
    );
  }

  dispose(): void {
    this.ws?.dispose();
    this.ws = null;
  }
}
