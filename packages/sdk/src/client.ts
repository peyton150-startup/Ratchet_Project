import type {
  EventInput,
  IngestResult,
  Task,
  TaskFilter,
  Webhook,
  RegisteredWebhook,
} from './types.js';

export class RatchetError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RatchetError';
  }
}

export interface RatchetClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Override fetch (e.g. for tests or a custom agent). Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Why a REST call was refused, from the API's { error, details } body: "invalid event: Unrecognized
 * key(s) in object: 'entityType'" tells an integrator what to fix; "HTTP 400" does not.
 */
async function failureReason(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
  };
  if (!body.error) return `HTTP ${res.status}`;
  const field = Object.entries(body.details?.fieldErrors ?? {})[0];
  const detail = body.details?.formErrors?.[0] ?? (field ? `${field[0]}: ${field[1][0]}` : undefined);
  return detail ? `${body.error}: ${detail}` : body.error;
}

/** Every field of Task, as a GraphQL selection. Exported so the consoles select the same shape. */
export const TASK_FIELDS =
  'id ruleKey ruleVersion queue template priority state assignee assigneeName slaDueAt subject createdAt updatedAt';

/** Typed client for the Ratchet API: REST ingest + webhooks, GraphQL tasks/queues. */
export class RatchetClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: RatchetClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    // Bind the default fetch to the global: the browser's fetch throws "Illegal invocation" when
    // called as a method of another object (here, as this.fetchFn), because it requires `this` to be
    // the Window/global. A caller-supplied fetch is used as given.
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  /** Post an event to the ingest API. */
  async ingest(event: EventInput): Promise<IngestResult> {
    const res = await this.fetchFn(`${this.baseUrl}/events`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new RatchetError(`ingest failed: ${await failureReason(res)}`, res.status);
    return (await res.json()) as IngestResult;
  }

  /** Execute a GraphQL operation and return its data (throws on GraphQL errors). */
  async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        accept: 'application/json, application/graphql-response+json',
      }),
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: T;
      errors?: Array<{ message: string }>;
      error?: string;
    };
    if (body.errors && body.errors.length > 0) {
      throw new RatchetError(body.errors[0]!.message, res.status);
    }
    // Auth and rate limiting answer before GraphQL runs, in the REST shape { error } with no
    // `errors` array. Without this the caller dereferences undefined data and reports a TypeError.
    if (!res.ok) throw new RatchetError(body.error ?? `graphql failed: HTTP ${res.status}`, res.status);
    return body.data as T;
  }

  tasks(filter: TaskFilter = {}): Promise<Task[]> {
    return this.graphql<{ tasks: Task[] }>(
      `query($queue: String, $state: String, $activeOnly: Boolean, $limit: Int) {
         tasks(queue: $queue, state: $state, activeOnly: $activeOnly, limit: $limit) { ${TASK_FIELDS} }
       }`,
      filter as Record<string, unknown>,
    ).then((d) => d.tasks);
  }

  task(id: string): Promise<Task | null> {
    return this.graphql<{ task: Task | null }>(
      `query($id: ID!) { task(id: $id) { ${TASK_FIELDS} } }`,
      { id },
    ).then((d) => d.task);
  }

  private mutateTask(field: string, id: string): Promise<Task> {
    return this.graphql<Record<string, Task>>(
      `mutation($id: ID!) { ${field}(id: $id) { ${TASK_FIELDS} } }`,
      { id },
    ).then((d) => d[field]!);
  }

  claimTask(id: string): Promise<Task> {
    return this.mutateTask('claimTask', id);
  }
  completeTask(id: string): Promise<Task> {
    return this.mutateTask('completeTask', id);
  }
  blockTask(id: string): Promise<Task> {
    return this.mutateTask('blockTask', id);
  }
  unblockTask(id: string): Promise<Task> {
    return this.mutateTask('unblockTask', id);
  }
  releaseTask(id: string): Promise<Task> {
    return this.mutateTask('releaseTask', id);
  }
  cancelTask(id: string): Promise<Task> {
    return this.mutateTask('cancelTask', id);
  }
  assignTask(id: string): Promise<Task> {
    return this.mutateTask('assignTask', id);
  }

  /** Register a webhook. The signing secret is returned once, here. */
  async registerWebhook(input: { url: string; events: string[] }): Promise<RegisteredWebhook> {
    const res = await this.fetchFn(`${this.baseUrl}/webhooks`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new RatchetError(`registerWebhook failed: HTTP ${res.status}`, res.status);
    return (await res.json()) as RegisteredWebhook;
  }

  async listWebhooks(): Promise<Webhook[]> {
    const res = await this.fetchFn(`${this.baseUrl}/webhooks`, { headers: this.headers() });
    if (!res.ok) throw new RatchetError(`listWebhooks failed: HTTP ${res.status}`, res.status);
    return (await res.json()) as Webhook[];
  }
}
