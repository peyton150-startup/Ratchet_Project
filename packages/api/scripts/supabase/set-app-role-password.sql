-- Give `ratchet_app` a login password. Run in the Supabase SQL editor, as one batch.
--
-- The password is generated in the database and shown once in the result. Copy it straight into
-- the DATABASE_URL secret and nowhere else. It is hex, so it needs no URL-encoding.
-- Re-running rotates the password: update DATABASE_URL on every service and redeploy them.

CREATE TEMP TABLE _ratchet_pw AS
  SELECT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') AS password;

DO $$
BEGIN
  EXECUTE format('ALTER ROLE ratchet_app LOGIN PASSWORD %L', (SELECT password FROM _ratchet_pw));
END $$;

SELECT password FROM _ratchet_pw;
