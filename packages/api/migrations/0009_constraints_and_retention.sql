-- Stability + data-integrity hardening.
--
-- 1. CHECK constraints: the task state machine and queue strategies were enforced only in
--    application code, so any direct SQL (a migration, a fix-up script, a future service) could
--    write a state the engine cannot handle. Constraints are features — let the database enforce
--    the invariant that the state machine depends on.
-- 2. Retention support: append-only tables grow forever. Indexes here make the purge cheap; the
--    purge itself is scripts/purge.ts, run on a schedule (steady state).

-- ---- task state machine -----------------------------------------------------------------------
ALTER TABLE tasks
  ADD CONSTRAINT tasks_state_chk
  CHECK (state IN ('open', 'claimed', 'blocked', 'completed', 'cancelled'));

-- A task must have a positive-length queue and template; empty strings are silent routing failures.
ALTER TABLE tasks
  ADD CONSTRAINT tasks_queue_not_empty CHECK (length(queue) > 0),
  ADD CONSTRAINT tasks_template_not_empty CHECK (length(template) > 0);

-- ---- routing ----------------------------------------------------------------------------------
ALTER TABLE queues
  ADD CONSTRAINT queues_strategy_chk
  CHECK (strategy IN ('round_robin', 'skill_tag', 'capacity'));

ALTER TABLE agents
  ADD CONSTRAINT agents_capacity_positive CHECK (capacity > 0);

-- ---- delivery / audit vocabularies ------------------------------------------------------------
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_status_chk CHECK (status IN ('delivered', 'failed'));

ALTER TABLE outbox
  ADD CONSTRAINT outbox_status_chk CHECK (status IN ('pending', 'relayed'));

ALTER TABLE rule_audit
  ADD CONSTRAINT rule_audit_trigger_chk CHECK (trigger_type IN ('event', 'schedule'));

-- ---- retention ---------------------------------------------------------------------------------
-- Purge scans are time-ordered deletes; these indexes keep them from becoming full scans.
CREATE INDEX IF NOT EXISTS rule_audit_created_idx ON rule_audit (created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries (created_at);
CREATE INDEX IF NOT EXISTS dead_letter_created_idx ON dead_letter (created_at);
-- Relayed outbox rows are dead weight once relayed; this index serves their cleanup.
CREATE INDEX IF NOT EXISTS outbox_relayed_idx ON outbox (relayed_at) WHERE status = 'relayed';

GRANT DELETE ON rule_audit, webhook_deliveries, dead_letter, outbox TO ratchet_app;
