-- Guaranteed delivery for the outbox->stream hop (EIP Guaranteed Delivery).
--
-- Before: the relay marked an outbox row 'relayed' as soon as it XADDed to the Redis stream. If the
-- stream trimmed that entry (approximate MAXLEN) or Redis lost data before a consumer processed it,
-- the event never became a task and nothing re-delivered it — a silent gap under backlog, exactly the
-- 1,000 ev/s load-test scenario. Postgres, not Redis, must be the source of delivery truth.
--
-- After: the consumer marks the row 'consumed' once the message is terminally handled (task created
-- or dead-lettered). A reconciliation sweep re-delivers rows stuck in 'relayed' past a threshold.
-- Re-delivery is safe because task creation is idempotent.

-- 'consumed' is the new terminal state.
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_status_chk;
ALTER TABLE outbox
  ADD CONSTRAINT outbox_status_chk CHECK (status IN ('pending', 'relayed', 'consumed'));

-- The consumer runs as ratchet_app (per-tenant, RLS): it needs UPDATE to mark rows consumed.
GRANT UPDATE ON outbox TO ratchet_app;

-- Purge target moves to 'consumed' (see scripts/purge.ts): 'relayed' rows may still need redriving,
-- so they must not be deleted. This index keeps that purge cheap.
CREATE INDEX IF NOT EXISTS outbox_consumed_idx ON outbox (relayed_at) WHERE status = 'consumed';
