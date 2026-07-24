-- Event payload schema versioning (DDIA Ch.4, Encoding and Evolution).
--
-- events.payload/delta are free-form jsonb with no version marker, so evolving a payload shape later
-- (rename/remove a field) risks old rules mis-reading new events and vice versa — the exact
-- backward/forward-compatibility trap the book warns about. Stamp every event with the producer's
-- schema version so rules and downstream consumers can dispatch on it instead of guessing a shape.
--
-- Constant DEFAULT: adds without a table rewrite (PG 11+), and propagates to every monthly partition
-- of the range-partitioned events table (ADR-002).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;
