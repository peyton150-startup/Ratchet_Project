# ADR-005: Multi-tenancy isolation model

**Status:** Accepted (2026-07-21)
**Decision:** Option 1 — pooled: shared DB, shared schema, Postgres row-level security (RLS),
with "every tenant table is RLS-enabled and FORCED" as a hard CI invariant.

## Context

Ratchet is multi-tenant. Design doc §8 asks for the tenant isolation model, RBAC roles, and where
RLS applies; Phase 3 names "Postgres row-level security" outright. This ADR commits the isolation
model and its sharp edges. Every tenant-owned table (event log, outbox, idempotency, tasks, queues,
rules, audit, api_keys) must isolate rows so a tenant can never read/write another tenant's data —
even through a buggy query.

Bounding constraints: single region, solo dev, demo-scale; exclusions rule out billing and SSO (no
compliance/commercial driver for physical isolation). ADR-002 already made tenant a column +
`(tenant_id, entity_id)` index and partitioned by time (not tenant), and ADR-001 shares Redis Streams
transport — both assume a pooled model. RBAC (operator/admin/integrator) is a separate layer within a
tenant; this ADR is the tenant boundary only.

## Options considered

- **1 — Pooled (shared schema + RLS).** Lightest ops (one DB, one migration), DB-enforced logical
  isolation, default-deny. Sharp edges: app must be a non-owner role, RLS must be FORCED, tenant set
  per transaction (pooler-safe), and a missing policy leaks silently — closed by a CI invariant.
- **2 — Bridge (schema-per-tenant).** Stronger separation but migrations ×N schemas, sprawl, partly
  fights ADR-002; overkill with no compliance driver.
- **3 — Silo (DB-per-tenant).** Maximal isolation, heaviest ops (N DBs to migrate/back up/monitor);
  against single-region/solo-dev scope.

## Decision (Option 1) — non-negotiable implementation rules

1. App connects as a **non-owner role**; every tenant table is `ENABLE` **+** `FORCE ROW LEVEL SECURITY`.
2. Tenant context via `SET LOCAL app.current_tenant_id = …` **inside each transaction**
   (transaction-pooler compatible).
3. **Default-deny**: policies use `USING` *and* `WITH CHECK` on `tenant_id`; no tenant set ⇒ zero rows,
   and writes cannot set a foreign `tenant_id`.
4. **CI invariant:** a test asserts every table with a `tenant_id` column has RLS enabled and forced —
   the guardrail against the one real failure mode (a new table that forgets a policy). Pairs with the
   duplicate-storm test as a safety-invariants suite.
5. A narrowly-scoped platform/bypass path (e.g. `SECURITY DEFINER` auth lookup, admin role) for
   cross-tenant operations, never used by request-path code.
6. RBAC sits above RLS as app-level authz within a tenant.

## Rationale

- Coherent with ADR-002 (tenant-as-column + time partitioning) and ADR-001 (shared transport);
  choosing 2/3 would force reworking them.
- Scope excludes the drivers for schema/DB-per-tenant (no billing, SSO, compliance, multi-region).
- RLS enforces isolation in the database, not in app WHERE clauses — strongest logical isolation
  without the physical-separation ops tax.
- Cheapest to operate and provision (a tenant is a row) — right for a solo-dev demo.

## Consequences

- RLS's failure mode is silent; the RLS-forced CI invariant (rule 4) is what makes pooled safe and is mandatory.
- Auth must resolve tenant before context is set — handled by a `SECURITY DEFINER` lookup that bypasses RLS deliberately.
- Migrations create the app role and set FORCE RLS; tables are owned by the migration/superuser role, app connects as the non-owner role.
- Option 2 (bridge) remains the step up if real compliance pressure ever appears, which current scope rules out.
