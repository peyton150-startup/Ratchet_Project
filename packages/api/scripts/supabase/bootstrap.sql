-- Supabase bootstrap. Run ONCE on a new Supabase project, as `postgres`, BEFORE the first
-- migration run. Safe to re-run.
--
-- Ratchet's migrations were written for a Postgres on a private network with nothing else in it.
-- Supabase differs in three ways that matter, and none of them produce an error if ignored:
--
--   1. Every object created in `public` is granted to anon/authenticated/service_role, which
--      publishes it through Supabase's auto-generated Data API. Ratchet does not use that API,
--      and `tenants` has no RLS, so it would be world-readable with the project's public key.
--   2. Functions are executable by PUBLIC. `ratchet_authenticate` is SECURITY DEFINER and
--      bypasses RLS on purpose, so it must be callable by `ratchet_app` only.
--   3. 0001_init.sql creates `ratchet_app` with a development password. This database is
--      reachable from the internet, so that password must never be live here.

-- 1. Stop the Data API grants for everything `postgres` creates in public from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated, service_role;

-- 2. No implicit PUBLIC execute on functions `postgres` creates. This has to be the global
--    default: a per-schema default can add privileges but cannot remove the built-in PUBLIC one.
--    Migrations grant EXECUTE to ratchet_app explicitly, so they are unaffected.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 3. Pre-create the app role without LOGIN. 0001_init.sql only creates the role when it is
--    missing, so its development password is never applied. The role cannot connect until
--    set-app-role-password.sql gives it a real one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ratchet_app') THEN
    CREATE ROLE ratchet_app NOLOGIN;
  END IF;
END $$;
