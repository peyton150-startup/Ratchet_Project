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
