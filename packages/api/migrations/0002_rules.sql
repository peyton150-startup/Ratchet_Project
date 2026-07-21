-- Ratchet Phase 2b: rules engine storage. Versioned JSON rules and an audit log of decisions.
-- Implements ADR-004 (structured JSON rules, trigger union) and ADR-005 (RLS forced on tenant tables).

-- Versioned rules. Many rows per (tenant, rule_key), one active version selected at evaluation time.
CREATE TABLE IF NOT EXISTS rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  rule_key    text NOT NULL,               -- stable id, e.g. 'R7'
  version     integer NOT NULL,            -- monotonically increasing per (tenant, rule_key)
  trigger     jsonb NOT NULL,              -- {type:'event',event} | {type:'schedule',cron,scan}
  condition   jsonb,                       -- structured condition tree; NULL means "always"
  action      jsonb NOT NULL,              -- {kind:'create_task',...} | {kind:'cancel_tasks',...}
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rule_key, version)
);
CREATE INDEX IF NOT EXISTS rules_active_idx ON rules (tenant_id, active);

-- Audit log: one row per rule evaluated against a trigger, capturing the rule version that fired
-- and the decision. dry_run rows are written only when a dry-run explicitly opts to persist.
CREATE TABLE IF NOT EXISTS rule_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  rule_key      text NOT NULL,
  rule_version  integer NOT NULL,
  trigger_type  text NOT NULL,             -- 'event' | 'schedule'
  event_id      uuid,                      -- set for event-triggered evaluations
  matched       boolean NOT NULL,
  decision      jsonb,                     -- the action the engine would take when matched
  dry_run       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rule_audit_tenant_created_idx ON rule_audit (tenant_id, created_at);

-- RLS (ADR-005): enable + FORCE on both tenant-owned tables.
ALTER TABLE rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules      FORCE  ROW LEVEL SECURITY;
ALTER TABLE rule_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_audit FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON rules
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON rule_audit
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT ON rules, rule_audit TO ratchet_app;
