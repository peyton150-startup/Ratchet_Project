// Ratchet SDK — typed client for the ingest REST API, GraphQL console API, and webhooks.
//
// This entry is browser-safe on purpose: the consoles import it, so it must not pull in node:crypto.
// Webhook signature verification is inherently server-side and lives in the "./signing" subpath
// (packages/sdk/src/signing.ts) — import it from there in server code.
export { RatchetClient, RatchetError, type RatchetClientOptions } from './client.js';
// Shared domain vocabulary: one definition of task states/transitions, the event catalog, the SLA
// format and the rules DSL, used by the API, the consoles and integrators alike.
export * from './domain.js';
export type {
  EventInput,
  IngestResult,
  Task,
  Queue,
  TaskFilter,
  Webhook,
  RegisteredWebhook,
} from './types.js';
