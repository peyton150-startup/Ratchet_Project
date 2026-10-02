// Public types for the Ratchet SDK. These mirror the API's ingest contract and GraphQL schema.

export interface EventInput {
  idempotencyKey: string;
  type: string;
  entityId: string;
  occurredAt?: string;
  delta?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

export interface Task {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  queue: string;
  template: string;
  priority: number;
  state: string;
  assignee: string | null;
  /** Name of the agent the task is routed to, when it has one. */
  assigneeName: string | null;
  slaDueAt: string | null;
  subject: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Queue {
  name: string;
  strategy: string;
  requiredSkill: string | null;
  active: boolean;
}

export interface TaskFilter {
  queue?: string;
  state?: string;
  /** Only tasks that can still be worked (open, claimed, blocked). */
  activeOnly?: boolean;
  limit?: number;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

export interface RegisteredWebhook {
  id: string;
  secret: string;
  url: string;
  events: string[];
}

export interface WebhookDelivery {
  id: string;
  eventType: string;
  /** delivered | failed */
  status: string;
  attempts: number;
  /** The endpoint's last HTTP status; null when it was never reached (blocked URL, open circuit). */
  responseStatus: number | null;
  createdAt: string;
}

/** The API key making the request. */
export interface Viewer {
  role: string;
  permissions: string[];
}
