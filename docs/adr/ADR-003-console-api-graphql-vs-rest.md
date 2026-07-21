# ADR-003: Console API — GraphQL vs REST

**Status:** Accepted (2026-07-21)
**Decision:** Option A — GraphQL for the consoles; REST + signed webhooks for integrators. Live
queue updates use GraphQL subscriptions (graphql-ws over WebSocket).

## Context

Two clients with different needs. **Consoles** (operator + admin) need rich nested reads
(task + event history + queue + rule version in one round-trip) and live queue updates. **Integrators**
need a stable, simple contract to post events and receive webhooks. Scope/Phase 3 already name
"GraphQL API for consoles" and "REST + signed webhooks for integrators"; this ADR confirms that split
and settles how live updates are delivered.

## Options considered

- **A — GraphQL for consoles, REST for ingest/webhooks.** Right tool per client: flexible nested/live
  reads for consoles; a trivially simple contract for third parties. Keeps the already-built, tested
  `POST /events` path untouched.
- **B — REST everywhere.** One style, easy caching, but consoles suffer (many endpoints or over/under-
  fetching) and live updates bolt on awkwardly.
- **C — GraphQL everywhere, including ingest.** One schema, but forces integrators to speak GraphQL for
  a trivial event post and complicates signed-webhook semantics. Poor fit for third parties.

## Decision

Option A, with **GraphQL subscriptions** for live queue updates.

Rationale for A: it matches scope wording, uses the right tool for each audience, and leaves the
ingest path (built and tested in Phase 2a) unchanged. The cost — maintaining two API styles — is
justified because the two audiences genuinely differ. Reject B (consoles suffer) and C (integrators
suffer).

Rationale for subscriptions over a separate/raw WebSocket (both use WebSocket; the choice is the
protocol over it):
- Same schema, types, and auth as queries/mutations — one mental model for the console.
- The Phase 3 TypeScript SDK covers live data for free; no separately hand-versioned message types.
- Live task shape is identical to the queried task shape (no drift).
- A raw socket's only real edge — fine-grained batching/backpressure at very high fan-out — is not
  needed for the scope's "<2s console update" target and demo-scale volume.

## Consequences

- Subscription resolvers publish from task state-machine transitions (Phase 2c) via a PubSub; auth is
  applied on connection init using the GraphQL context (tenant + RBAC).
- Multi-instance deployment requires a shared fan-out (Redis PubSub/Streams) so an event on one API
  pod reaches subscribers on another. This cost is identical for a raw socket, so it is not a
  differentiator — but must be planned (Redis is already in the stack).
- Ingest and webhooks remain REST; signed-webhook delivery is specified in Phase 3.
- If very-high-frequency broadcast ever demands manual backpressure control, a dedicated socket channel
  can be added alongside subscriptions without changing this decision for the general case.
