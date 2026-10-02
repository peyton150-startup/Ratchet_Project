# Working in this repo

Deployment notes that are not discoverable from the code. Each one below has already
caused a failure that looked like success — a green build, a passing healthcheck, or a
200 response — while the system was actually broken.

## Supabase

**Connection strings must end in `?sslmode=verify-full` (or `require`).** Without it `pg` connects in plaintext
and Supabase's pooler accepts the connection, so everything works while credentials and tenant
data cross the internet unencrypted. With it, `pg` verifies against Supabase's own CA, which
only the Docker image trusts (`NODE_EXTRA_CA_CERTS`). Running a script from a laptop without
that variable fails with `SELF_SIGNED_CERT_IN_CHAIN`; the fix is the variable, not
`sslmode=no-verify`.

**Run `packages/api/scripts/supabase/bootstrap.sql` before the first migration on a new
project.** Supabase grants its Data API roles full access to every new table in `public`, and
`tenants` has no RLS. Migrations applied without the bootstrap succeed, the app works, and the
tenant list is readable by anyone holding the project's public key.

**`DATABASE_URL` must be the `ratchet_app` role, never `postgres`.** Row-level security is
enforced against `ratchet_app`. Supabase's `postgres` role is not a superuser, but it has
`BYPASSRLS`, so pointing `DATABASE_URL` at it silently disables tenant isolation: `/health`
passes, `/db-check` passes, queries return rows. This nearly shipped during the Northflank
cutover, when the pooler string was pasted into `DATABASE_URL` unchanged. Check
`pg_stat_activity` for the connected role instead of trusting the endpoints.
`ADMIN_DATABASE_URL` is the `postgres` role, used by migrations and by the worker's
cross-tenant relay and sweeps. The API must never receive it.

**Do not run the API test suite against it.** The suite needs a database it can fill with
throwaway tenants. Locally it also fails one pipeline test against a database that earlier runs
have dirtied; a fresh database passes 79/79.

## Northflank

**The US East region refuses free projects.** Project creation fails there with a 409, so the
services run in `us-central`, one region away from the database. Moving them to a paid region
to close that gap is a billing decision, not a config change.

**The API and the worker get different secret groups.** `ratchet-db-admin` holds
`ADMIN_DATABASE_URL` and is restricted to the worker. Attaching it to the API, or making it
unrestricted, hands a `BYPASSRLS` connection to the request path, and nothing fails.

**`REDIS_URL` is linked from the addon, not typed in.** It is the addon's `REDIS_MASTER_URL`
aliased in the `ratchet-shared` secret group. Recreating the addon changes the URL; relink it
rather than pasting the new value.

**Keep the Redis addon on `noeviction`.** The event stream lives in Redis. Any other policy
drops stream entries under memory pressure, and the only symptom is tasks arriving minutes late
when the outbox redrive recovers them.

## Vercel

**`VITE_API_URL` is baked in at build time.** It is read by `packages/web/src/main.tsx`
during the Vite build, not at runtime. Changing it in project settings does nothing to the
deployed bundle until a redeploy.

**Renaming a project does not move the site.** Aliases only regenerate on the next
production deploy, so the old URL keeps serving and the new one 404s. When the canonical
URL does change, it must be added to `CORS_ORIGINS` on the API or every console request
fails. Team-scoped aliases (`<project>-<team>.vercel.app`) sit behind Vercel SSO and are
not publicly reachable; the public URL is the short `<project>.vercel.app`.

## Both platforms

**`@workspace/sdk` must be built before `@workspace/api` or `@workspace/web`.** Both
resolve it through `dist/`, so a build command that targets only the leaf package fails
with `TS2307: Cannot find module '@workspace/sdk'` plus a cascade of `unknown` and
implicit-`any` errors downstream. Those downstream errors are symptoms — fix the build
order, not the types.

**`packages/api` is ESM.** Relative imports need explicit `.js` extensions; `tsc` is set to
`NodeNext` so it rejects bare specifiers at compile time rather than emitting output that
builds cleanly and cannot start.
