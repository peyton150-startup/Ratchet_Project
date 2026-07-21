# ADR-002: Partitioning the event log in Postgres

**Status:** Accepted (2026-07-21)
**Decision:** Option A — range partition by time (monthly), secondary btree index on
`(tenant_id, entity_id)`, automated partition creation via pg_partman or a small scheduled job.

## Context

The event log is the append-only source of truth: every `POST /events` appends one immutable,
time-ordered row; nothing updates or deletes. It grows monotonically and sits in the hot ingest
path that must sustain 1,000 events/sec (~86M rows/day at sustained peak). A single unpartitioned
table eventually hits index-bloat on insert and unmaintainable size (no cheap VACUUM/reindex/aging).

Query shapes that matter:
- "events since T" and time-bounded scans — rules-engine delta and R11 scheduled sweeps (hot path).
- "events for application/entity X" — task detail / event history in the Phase 4 operator console.

Bounding constraints: append-only and time-ordered; 1,000/s writes; multi-tenant (ADR-005 still
open); append-forever needs cheap retention; solo dev needs automated partition maintenance.

## Options considered

- **A — Range by time (monthly).** Writes land in the current partition (sequential, natural for a
  log); time-bounded reads prune; retention is `DROP`/`DETACH` of an old month; tenancy rides as a
  column + index, isolated by RLS — so it stays decoupled from ADR-005.
- **B — List/hash by tenant_id.** Strong per-tenant pruning/isolation, but time-based aging within a
  tenant reverts to mass `DELETE`, and it pre-commits ADR-005 to physical isolation.
- **C — Two-level: time × tenant hash.** Prunes on both axes but most partitions/DDL to manage;
  over-engineered for current volumes.
- **D — No partitioning + BRIN on created_at.** Simplest now; retention becomes mass `DELETE` and a
  painful migration-to-partitioned later; defers a requirement the design doc explicitly asks for.

## Decision

Option A. It matches the data's time-series nature, prunes the hot time-bounded reads (R11 sweeps,
deltas), makes retention trivial (`DROP` a month), stays decoupled from the still-open ADR-005
(tenant is a column + `(tenant_id, entity_id)` index, isolated by RLS), and its maintenance is a
solved problem (pg_partman or a small "ensure next partition exists" job). Monthly ranges for the
demo; revisit weekly only if a month's partition grows unwieldy under sustained load.

## Consequences

- Entity-history reads rely on the secondary btree `(tenant_id, entity_id)`, not partition pruning.
- A scheduled job must pre-create the next partition ahead of time (operational task to build/monitor).
- If ADR-005 chooses hard physical tenant isolation, revisit — though time-range partitioning within
  each tenant's log is the likely shape, so this generalizes.
- Retention/aging policy (how many months to keep before DETACH/archive) is a follow-up to define.
