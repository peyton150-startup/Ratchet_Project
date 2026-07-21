-- Ratchet Phase 3: routing & assignment. Agents, queues (with an assignment strategy), queue
-- membership, and task assignment columns. RLS forced on all tenant tables (ADR-005).

-- An agent is an assignment target (an operator). RBAC (next slice) will link agents to users/roles.
CREATE TABLE IF NOT EXISTS agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  name              text NOT NULL,
  skills            text[] NOT NULL DEFAULT '{}',
  capacity          integer NOT NULL DEFAULT 5,   -- max concurrent non-terminal assignments
  active            boolean NOT NULL DEFAULT true,
  last_assigned_at  timestamptz,                  -- drives round-robin fairness
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_tenant_active_idx ON agents (tenant_id, active);

-- A queue's assignment strategy. Tasks reference a queue by name (tasks.queue).
CREATE TABLE IF NOT EXISTS queues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  name            text NOT NULL,
  strategy        text NOT NULL DEFAULT 'round_robin',  -- round_robin | skill_tag | capacity
  required_skill  text,                                 -- used by skill_tag
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Which agents serve which queue.
CREATE TABLE IF NOT EXISTS queue_members (
  tenant_id  uuid NOT NULL,
  queue      text NOT NULL,
  agent_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, queue, agent_id)
);

-- Assignment columns on tasks.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee    uuid;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (tenant_id, assignee)
  WHERE state NOT IN ('completed', 'cancelled');

-- RLS (ADR-005): enable + FORCE on the new tenant-owned tables.
ALTER TABLE agents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents        FORCE  ROW LEVEL SECURITY;
ALTER TABLE queues        ENABLE ROW LEVEL SECURITY;
ALTER TABLE queues        FORCE  ROW LEVEL SECURITY;
ALTER TABLE queue_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agents
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON queues
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON queue_members
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON agents, queues, queue_members TO ratchet_app;
