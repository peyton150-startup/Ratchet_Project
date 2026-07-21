# ADR-001: How committed events reach downstream processing

**Status:** Accepted (2026-07-21)
**Decision:** Option A — transactional outbox in Postgres, relayed to Redis Streams.

## Context

Core path: `POST /events` → append to event log → rules engine evaluates → task
service creates tasks. This ADR decides how a durably committed event is reliably
handed to the rules/task workers without the DB write and the "notify a worker"
step being able to disagree (the dual-write problem).

Bounding constraints (from scope.md / design.md):

- Exactly-once task creation per `(event, rule)`, proven by a duplicate-storm test in CI.
- 1,000 events/sec sustained; p95 ingest latency target.
- Stack fixed to Postgres + Redis; new infra (Kafka/SQS) is out of scope.
- Solo developer, single region, Oracle Cloud + k3s — ops burden is a first-class cost.
- Design doc already names "Event log and outbox" as a component; the open choice is the transport.
- Phase 2c needs retry/backoff and a dead-letter queue.

## Options considered

- **A — Transactional outbox (Postgres) → Redis Streams.** Event + outbox row commit in
  one transaction; a relay pushes outbox rows to a Redis Stream; workers consume via
  consumer groups (ack, pending-entry list, claim, dead-letter stream). Exactly-once is an
  *effect*: outbox gives at-least-once delivery, `UNIQUE(event_id, rule_id)` on task
  creation makes the observable result exactly-once.
- **B — Dedicated broker (Kafka/RabbitMQ).** Purpose-built, scales past 1,000/s, but adds an
  operational dependency excluded by scope and *still* needs an outbox/CDC for atomicity.
- **C — Outbox is the queue via `SELECT … FOR UPDATE SKIP LOCKED`.** Fewest moving parts;
  retry/DLQ and console fan-out become bespoke SQL/NOTIFY code.

## Decision

Option A. It uses only the fixed stack (Redis already required), the outbox is already a
decided component, and Redis Streams' consumer-group primitives map directly onto the
Phase 2c retry/backoff/DLQ requirements — so less bespoke reliability code — while Streams
fan-out helps the "<2s live console" goal. Consumers read through a transport abstraction so
a future swap to a broker stays contained.

## Consequences

- Exactly-once correctness rests on the downstream `UNIQUE(event_id, rule_id)` constraint,
  which the duplicate-storm test pins down — not on transport delivery semantics.
- We operate a relay process and a Redis Streams consumer topology (main + dead-letter streams).
- Option C remains the fallback if we later choose to drop Redis from the hot path.
- Option B is rejected for this project (adds excluded infra, doesn't remove the outbox).
