-- Scheduled (R11) rules should re-fire once the prior task closes, while event rules stay
-- exactly-once forever. The single all-time UNIQUE(tenant_id, dedup_key) enforced both paths the
-- same way, which pinned a scheduled subject to one task for all time (a completed "stale document"
-- task could never be raised again). Split it into two partial unique indexes so each path gets the
-- semantics it needs.

-- Drop the all-time uniqueness (default name for UNIQUE(tenant_id, dedup_key) on `tasks`).
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_tenant_id_dedup_key_key;

-- Event-origin tasks (event_id NOT NULL): exactly-once per (event, rule) for ALL time, so a
-- redelivered event never creates a second task even after the first is completed/cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedup_event_uk
  ON tasks (tenant_id, dedup_key)
  WHERE event_id IS NOT NULL;

-- Scheduled-origin tasks (event_id NULL): at most one ACTIVE task per (rule, subject). A task that
-- has reached a terminal state leaves this index, so the next sweep re-fires. The active-state list
-- must stay in sync with ACTIVE_TASK_STATES in packages/sdk/src/domain.ts (open/claimed/blocked).
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedup_sched_uk
  ON tasks (tenant_id, dedup_key)
  WHERE event_id IS NULL AND state IN ('open', 'claimed', 'blocked');
