# Ratchet design doc

Status: delivered | Author: Nic Reilly | Last updated: 2026-07-26

## 1. Overview and goals

Ratchet is a multi-tenant task orchestration platform. Client systems post entity change events to it. Ratchet evaluates versioned rules against each event, and when a rule matches it creates a task in a queue with an SLA. Operators work those tasks in a console. The point is that the next action in a multi-step process gets created automatically instead of living in someone's head.

Built for teams running processes like loan origination, onboarding, or claims. Scope statement: `scope.md`. Demo domain: `demo-domain.md`.

## 2. Non-goals

No billing, no SSO, no mobile app, single region. Also deliberately not built, despite being tempting: a general workflow engine (Ratchet reacts to events, it does not orchestrate long-running sagas), human task assignment beyond round-robin and queue membership, and a plugin system for custom rule operators. The rule DSL is a fixed operator set on purpose (ADR-004).

## 3. System context

```
  client systems ──POST /events──▶ ┌──────────────────────────┐
                                   │         Ratchet          │
  integrators   ◀──signed webhook──│                          │
                                   │  ingest → outbox → relay │
  operators     ──GraphQL/WS─────▶ │  → consumer → rules      │
  admins        ──GraphQL────────▶ │  → tasks → routing       │
                                   └──────────────────────────┘
                                     Postgres (log, tasks, rules)
                                     Redis (streams, cache, pubsub)
```

## 4. Architecture

One subsection per component. Each says what it owns, what crosses its boundary, and why it is separate.

**Ingest API** (`api/src/events/`). Accepts `POST /events`, authenticates the API key, validates against the event schema, and appends to the event log and the outbox in one transaction. Deduplicates on an idempotency key, so a client retry returns 200 rather than creating a second event. Separate because it is the only hot path with a latency budget, and because everything downstream must be able to fall behind without dropping events.

**Event log and outbox** (`events` and `outbox` tables). The event log is append-only and is the source of truth. The outbox exists to solve the dual-write problem: the event row and the "tell a worker" row commit together, so they cannot disagree. A relay reads the outbox and pushes to a Redis Stream (ADR-001). The log is range-partitioned by month with a secondary index on `(tenant_id, entity_id)`, so retention is a partition drop rather than a delete (ADR-002).

**Rules engine** (`api/src/rules/`). Evaluates a versioned JSON condition tree against an event. Three things it must do, which shaped the whole design:
- Query current application state, not just the incoming event (rule R7). Conditions can read across entities via allowlisted `state.*` predicates.
- Read which fields changed, because the event payload carries the delta (rule R10).
- Fire on a schedule with no triggering event, via a scan (rule R11). Sweeps are a trigger type on a rule rather than a separate mechanism (ADR-004).

Rules are versioned, support dry-run, and every decision writes a `rule_audit` row naming the version that fired.

**Task service** (`api/src/tasks/`). Owns the task state machine. States: `open`, `claimed`, `blocked`, `completed`, `cancelled`. Actions: `claim`, `complete`, `block`, `unblock`, `release`, `cancel`. The transition table lives once in the shared SDK domain module so the API, the consoles, and integrators cannot drift apart. Illegal transitions throw rather than silently no-op. `completed` and `cancelled` are terminal.

**Routing and assignment** (`api/src/routing/`). Places a created task into a queue and assigns it to an agent from that queue's membership.

**Pipeline** (`api/src/pipeline/`). Relay, consumer, worker, scheduler, backoff, and dead-letter handling. Exactly-once task creation per `(event, rule)` pair is enforced here and proven by a duplicate-storm test in CI.

**Consoles** (`packages/web/`). Operator console for working queues, admin console for rules and queue administration. Live queue updates over GraphQL subscriptions.

**Webhooks** (`api/src/webhooks/`). Outbound delivery to integrators with HMAC signing, delivery records, timeouts, and a URL guard against SSRF.

## 5. Data model

Core tables: `tenants`, `events` (partitioned), `event_idempotency`, `outbox`, `dead_letter`, `rules`, `rule_audit`, `tasks`, `queues`, `queue_members`, `agents`, `api_keys`, `webhooks`, `webhook_deliveries`.

Event schema versioning is carried on the event row (`0012_event_schema_version.sql`), so an old event replays under the schema it was written with. Partitioning plan is in ADR-002: monthly range partitions on the event log, created ahead of time by a scheduled job, dropped for retention.

## 6. Key flows

**Event to task.** Client posts an event with an idempotency key. API validates and writes the event plus an outbox row in one transaction, returns 201 (or 200 on a duplicate). Relay reads the outbox and publishes to a Redis Stream. Consumer picks it up, the rules engine evaluates matching rule versions, and each match creates a task through the task service with a queue and an SLA due time. Routing assigns it. Consoles see it live.

**Replay.** Events are immutable and time-ordered, so a rule version can be re-evaluated against a historical range. Dry-run mode evaluates without creating tasks.

**SLA breach and escalation.** Tasks carry an SLA due time computed at creation. The scheduler scans for breaches. Scheduled sweeps (R11) use the same mechanism.

**Failure.** A message that fails past its retry budget goes to `dead_letter`. `redriveDlq.ts` replays it once the cause is fixed, and `ratchet_outbox_redriven_total` tracks how often that happens.

## 7. API design

GraphQL for the consoles: nested reads (task plus event history plus queue plus rule version in one round trip) and live updates via `graphql-ws` subscriptions. REST for integrators: `POST /events` in, signed webhooks out. The split is deliberate, and the reasoning is in ADR-003. Integrators should not have to speak GraphQL to post one event.

## 8. Multi-tenancy and authz

Pooled model: shared database, shared schema, Postgres row-level security, forced (ADR-005). The application connects as a non-owner role so RLS cannot be bypassed, and the tenant is set per transaction so it is safe behind a connection pooler. Every tenant-owned table is RLS-enabled, and that is a CI invariant rather than a convention, because a missing policy leaks silently.

RBAC within a tenant: `operator`, `admin`, `integrator`. API keys carry a role and a scope such as `events:ingest`.

## 9. Reliability and failure modes

- **Idempotency.** Client-supplied key on ingest; `(event, rule)` uniqueness on task creation.
- **Exactly-once.** Means exactly-once task creation per event and rule, not exactly-once delivery. Delivery is at-least-once; deduplication at the task boundary is what makes it safe.
- **Retry and backoff.** Exponential backoff in `pipeline/backoff.ts`.
- **Dead letter.** After the retry budget, with a redrive script.
- **Timeouts and circuit breaker.** `stability.ts` wraps outbound calls, and `ratchet_circuit_opened_total` reports when a breaker trips.
- **Where it breaks down.** If Redis loses a stream entry after the outbox row is marked sent, that event needs redrive. This is why the outbox row is the durable record and the stream is treated as transport, not storage.

## 10. Performance targets

1,000 events/sec sustained with p95 ingest latency under 200 ms, proven by the k6 run in `load/`. The run also fails on error rate above 1% or any rate limiting. Because every accepted event flows through the full pipeline, a sustained run doubles as the stress test for exactly-once and outbox redrive under backlog. Run the generator from a separate machine and publish server specs with the results.

## 11. Observability

Prometheus metrics on `/metrics`: `ratchet_events_ingested_total`, `ratchet_tasks_created_total`, `ratchet_pipeline_messages_total`, `ratchet_pipeline_errors_total`, `ratchet_outbox_redriven_total`, `ratchet_rate_limited_total`, `ratchet_circuit_opened_total`, `ratchet_webhook_deliveries_total`, `ratchet_webhook_timeouts_total`, plus `ratchet_http_requests_total` and `ratchet_http_request_seconds`.

## 12. Testing strategy

Unit tests for pure logic (rules conditions, state machine, SLA parsing). Integration tests against real Postgres and Redis in CI, not mocks. Component tests for the consoles.

The three that matter most, all in CI:
- **Duplicate storm** (`ingest.test.ts`, `pipeline.test.ts`): proves exactly-once task creation under retry pressure.
- **Poison message** (`pipeline.test.ts`): proves a bad message lands in the dead letter queue instead of blocking the stream.
- **Illegal state transitions** (`tasks.test.ts`): proves the state machine rejects rather than silently accepting.

Plus `rls.test.ts`, which asserts cross-tenant reads fail. That one is the invariant behind ADR-005.

## 13. Rollout

Walking skeleton first: one posted event creating one task visible in a console at a public URL. Then phases 1 to 4 as the core. Cut line is the phase 0 to 4 core; everything on the expansion list is excluded from v1 and added one at a time afterward.

## 14. Open questions

None blocking. Resolved during the build:
- Sweeps are a rule trigger type, not a separate mechanism (ADR-004).
- Live console updates are GraphQL subscriptions over WebSocket, not polling (ADR-003).
- Tenancy is pooled with forced RLS, not schema-per-tenant (ADR-005).

Deferred, and honest about it: no multi-region story, no rule builder undo history, and outbox relay is a single process rather than a leader-elected set.

## 15. ADR index

- ADR-001: Outbox vs message broker
- ADR-002: Event log partitioning in Postgres
- ADR-003: GraphQL vs REST for console APIs
- ADR-004: Rules DSL shape, covering state-querying, delta-based, and time-triggered rules (R7, R10, R11)
- ADR-005: Multi-tenancy isolation model

The AI build model split is section 16 below rather than an ADR, since it is a process decision rather than an architectural one.

## 16. AI build strategy

Which model wrote what, so a later audit knows where to look.

**GLM 5.2 (free, NVIDIA API):** scaffolding, CRUD endpoints, React consoles, test boilerplate, seed data, migrations, k6 scripts, docs drafts.

**Opus/Fable:** this design doc and all ADRs, outbox and idempotency, task state machine, rules engine core, auth and row-level security, retry and concurrency logic, per-PR review of GLM kernel code, hard debugging, and the final whole-scale audit.

Rule: GLM writes what tests can catch. Opus/Fable writes what tests might miss.

Every PR carries a label for the model that wrote it (`glm` or `claude`), so the closing audit can slice findings by author.
