-- Ratchet Phase 3 hardening: idempotency fingerprint + a supporting index for state predicates.
-- Both additive and backward-compatible (nullable column, new index).

-- #2 Idempotency conflict detection: remember a fingerprint of the original request body so a
-- reused key with a DIFFERENT body can be rejected (409) instead of silently replaying. Nullable
-- so pre-existing rows (which have no fingerprint) are treated as a match, never a false conflict.
ALTER TABLE event_idempotency ADD COLUMN IF NOT EXISTS request_hash text;

-- #7 State-predicate queries (all_required_docs_verified, R11 scan) filter on event_type and
-- payload->>'applicationId'. Index that access path (propagates to partitions).
CREATE INDEX IF NOT EXISTS events_type_appid_idx
  ON events (event_type, (payload->>'applicationId'));
