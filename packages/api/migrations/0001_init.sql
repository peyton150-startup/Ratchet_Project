-- Ratchet Phase 2a: event ingest, append-only log, transactional outbox, idempotency, RLS.
-- Implements ADR-001 (outbox), ADR-002 (monthly range partitioning), ADR-005 (pooled RLS).
-- Run as a superuser/owner role (migrations); the API connects as the non-owner role below.

-- App role the API connects as. Non-owner, non-superuser, so RLS is enforced for it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ratchet_app') THEN
    CREATE ROLE ratchet_app LOGIN PASSWORD 'ratchet_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ratchet_app;

-- Platform table: tenant registry. No tenant_id column -> not a tenant-owned table.
CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- API keys for bearer auth. Tenant-owned -> RLS enforced. Auth resolves via SECURITY DEFINER fn below.
CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key_hash    text NOT NULL UNIQUE,
  name        text NOT NULL DEFAULT 'default',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only event log. Range-partitioned by month on occurred_at (ADR-002).
-- A partitioned table's PK must include the partition key, hence (id, occurred_at).
CREATE TABLE IF NOT EXISTS events (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  event_type  text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  delta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Secondary index for entity-history reads (ADR-002).
CREATE INDEX IF NOT EXISTS events_tenant_entity_idx ON events (tenant_id, entity_id);

-- Default partition catches any range. A scheduled job pre-creates month partitions (ADR-002 follow-up).
CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;

-- Idempotency guard. Separate, non-partitioned table so UNIQUE(tenant_id, idempotency_key) is valid
-- (a unique index on the partitioned events table would have to include occurred_at, defeating dedupe).
CREATE TABLE IF NOT EXISTS event_idempotency (
  tenant_id       uuid NOT NULL,
  idempotency_key text NOT NULL,
  event_id        uuid NOT NULL,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

-- Transactional outbox (ADR-001): written in the same tx as the event; relayed to Redis Streams later.
CREATE TABLE IF NOT EXISTS outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  event_id    uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  topic       text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  relayed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (created_at) WHERE status = 'pending';

-- ---------- RLS (ADR-005): enable + FORCE on every tenant-owned table ----------
ALTER TABLE api_keys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys          FORCE  ROW LEVEL SECURITY;
ALTER TABLE events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE events            FORCE  ROW LEVEL SECURITY;
ALTER TABLE event_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_idempotency FORCE  ROW LEVEL SECURITY;
ALTER TABLE outbox            ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox            FORCE  ROW LEVEL SECURITY;

-- Default-deny tenant policies. current_setting(..., true) returns NULL when unset -> predicate NULL -> deny.
CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON event_idempotency
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Grants to the app role (tables owned by the migration role).
GRANT SELECT, INSERT ON events, event_idempotency, outbox TO ratchet_app;
GRANT SELECT ON api_keys TO ratchet_app;
GRANT SELECT ON tenants TO ratchet_app;

-- SECURITY DEFINER auth lookup: resolves tenant from key hash, bypassing RLS deliberately (ADR-005 rule 5).
CREATE OR REPLACE FUNCTION ratchet_authenticate(p_key_hash text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM api_keys WHERE key_hash = p_key_hash;
$$;
GRANT EXECUTE ON FUNCTION ratchet_authenticate(text) TO ratchet_app;
