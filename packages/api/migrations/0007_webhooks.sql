-- Ratchet Phase 3: signed webhooks for integrators. Registered endpoints + a delivery log.
-- RLS forced on both tenant-owned tables (ADR-005).

CREATE TABLE IF NOT EXISTS webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  url         text NOT NULL,
  secret      text NOT NULL,               -- HMAC signing secret (returned once at creation)
  events      text[] NOT NULL DEFAULT '{}',-- subscribed event types, e.g. task.created / task.updated
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_tenant_active_idx ON webhooks (tenant_id, active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  webhook_id      uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL,           -- delivered | failed
  attempts        integer NOT NULL,
  response_status integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_idx ON webhook_deliveries (tenant_id, created_at);

ALTER TABLE webhooks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks           FORCE  ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhooks
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON webhooks TO ratchet_app;
GRANT SELECT, INSERT ON webhook_deliveries TO ratchet_app;
