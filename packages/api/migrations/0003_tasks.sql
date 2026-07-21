-- Ratchet Phase 2c: task service. Tasks with an explicit state machine, SLA timers, priorities,
-- exactly-once creation per (event, rule), and a dead-letter table for poison messages.
-- Implements ADR-005 (RLS forced on tenant tables).

CREATE TABLE IF NOT EXISTS tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  -- Idempotency key for exactly-once creation. Event rules: '<event_id>:<rule_key>'.
  -- Scheduled rules: '<rule_key>:<subject>'. UNIQUE collapses duplicates and retries.
  dedup_key     text NOT NULL,
  rule_key      text NOT NULL,
  rule_version  integer NOT NULL,
  event_id      uuid,                        -- NULL for scheduled-rule tasks
  queue         text NOT NULL,
  template      text NOT NULL,
  priority      integer NOT NULL DEFAULT 0,
  state         text NOT NULL DEFAULT 'open',
  subject       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sla_due_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS tasks_queue_state_idx ON tasks (tenant_id, queue, state);
-- Supports SLA-breach scans over non-terminal tasks.
CREATE INDEX IF NOT EXISTS tasks_sla_idx ON tasks (tenant_id, sla_due_at)
  WHERE state NOT IN ('completed', 'cancelled');

-- Dead-letter sink for messages that exhausted their retry budget (poison messages).
CREATE TABLE IF NOT EXISTS dead_letter (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  source      text NOT NULL,                 -- e.g. 'task_processing'
  reference   text,                          -- e.g. event id or outbox id
  payload     jsonb NOT NULL,
  error       text NOT NULL,
  attempts    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dead_letter_tenant_created_idx ON dead_letter (tenant_id, created_at);

-- RLS (ADR-005): enable + FORCE on both tenant-owned tables.
ALTER TABLE tasks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks       FORCE  ROW LEVEL SECURITY;
ALTER TABLE dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tasks
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON dead_letter
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Tasks need UPDATE for state-machine transitions.
GRANT SELECT, INSERT, UPDATE ON tasks TO ratchet_app;
GRANT SELECT, INSERT ON dead_letter TO ratchet_app;
