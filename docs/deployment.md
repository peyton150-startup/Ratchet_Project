# Deploying Ratchet

```
Vercel      packages/web        operator and admin consoles (static bundle)
Northflank  ratchet-api         node packages/api/dist/index.js
Northflank  ratchet-worker      node packages/api/dist/pipeline/worker.js
Northflank  ratchet-migrate     node packages/api/dist/migrate.js   (job, run before each release)
Supabase    Postgres            plain Postgres over `pg`; no Supabase APIs, Auth or client library
Upstash     Redis               streams, pub/sub, cache; TLS (`rediss://`)
```

The API, the worker and the migration job are one image ([`Dockerfile`](../Dockerfile)) started
with three different commands. The API and worker stay separate processes: the worker is a
continuous loop, not a request handler, and must be an always-on service.

Status: the image and the Supabase database are verified (see [What has been verified](#what-has-been-verified)).
The Northflank services have not been created yet. `packages/api/railway.json` and
`railway.worker.json` describe the previous host and stay until the cutover below is complete.

## Environment variables

| Variable | API | Worker | Migrate job | Notes |
|---|---|---|---|---|
| `DATABASE_URL` | required | required | | The `ratchet_app` role. Never `postgres`: a role with `BYPASSRLS` silently disables tenant isolation |
| `ADMIN_DATABASE_URL` | | required | required | The `postgres` role. The worker needs it for the outbox relay, redrive and scheduled sweeps, which are cross-tenant |
| `REDIS_URL` | required | required | | Upstash, `rediss://` |
| `CORS_ORIGINS` | required | | | Comma-separated. Also gates the WebSocket handshake. Unset means no cross-origin access at all |
| `PORT` | optional | | | Defaults to 3000. Northflank does not inject it; expose whichever port this is |
| `PG_POOL_MAX` | recommended `5` | recommended `5` | | Default 10. See [Connection budget](#connection-budget) |

Do not give the API `ADMIN_DATABASE_URL`. `config.ts` falls back to `DATABASE_URL` when it is
unset, and the API never opens an admin pool.

Optional tuning, all with safe defaults: `PG_STATEMENT_TIMEOUT_MS` (10000),
`PG_IDLE_IN_TX_TIMEOUT_MS` (15000), `PG_CONNECT_TIMEOUT_MS` (5000), `LOG_LEVEL`,
`MAX_BODY_SIZE` (256kb), `INGEST_RATE_WINDOW_MS` (1000), `INGEST_RATE_MAX` (2000),
`MAX_SCAN_ROWS`, `WEBHOOK_TIMEOUT_MS`, `RATCHET_STREAM` (`ratchet:events`),
`RATCHET_GROUP` (`rules-workers`). Leave `NODE_EXTRA_CA_CERTS` alone; the image sets it.

Vercel has one: `VITE_API_URL`, the public origin of `ratchet-api`. It is baked in at build time.

## Supabase

### Connection strings

Use the **Session pooler** (port 5432) from the project's Connect dialog. Copy the host from
there; it is not derivable from the project ref. The direct connection is IPv6-only, and the
transaction pooler (port 6543) is not needed: Ratchet holds a small fixed pool per process.

```
ADMIN_DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=require
DATABASE_URL=postgresql://ratchet_app.<PROJECT_REF>:<APP_ROLE_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=require
```

`?sslmode=require` is not optional. Without it `pg` connects in plaintext and the pooler accepts
it, so credentials and tenant data cross the internet unencrypted with nothing reporting a
problem. With it, `pg` verifies the certificate chain and hostname against Supabase's CA, which
the image trusts through `packages/api/certs/supabase-root-2021-ca.crt`. Outside the image, set
`NODE_EXTRA_CA_CERTS` to that file or the connection fails with `SELF_SIGNED_CERT_IN_CHAIN`.

### New project

1. Run [`packages/api/scripts/supabase/bootstrap.sql`](../packages/api/scripts/supabase/bootstrap.sql)
   in the SQL editor. It must run before the first migration; the file explains why.
2. Run the migrations (the `ratchet-migrate` job, or `pnpm --filter @workspace/api migrate` with
   `ADMIN_DATABASE_URL` set).
3. Run [`set-app-role-password.sql`](../packages/api/scripts/supabase/set-app-role-password.sql)
   in the SQL editor and put the password it returns into `DATABASE_URL`.
4. Seed and issue a key from a laptop. Unlike the old private-network database, Supabase is
   reachable from outside, so these run locally with `ADMIN_DATABASE_URL` and
   `NODE_EXTRA_CA_CERTS` set:

   ```bash
   pnpm --filter @workspace/api seed -- --tenant demo
   pnpm --filter @workspace/api issue-key -- --tenant demo --role admin
   ```

Never point the API test suite at this database. It writes hundreds of tenants and does not
clean up.

### Connection budget

In session mode every client connection holds a Postgres connection, and Supabase caps them per
role (15 by default on the smallest compute size; check Database settings for the current
value). At the
default `PG_POOL_MAX` of 10, the API and the worker can together ask for 20 connections as
`ratchet_app`. Set `PG_POOL_MAX=5` on both so the total is 10 as `ratchet_app` and 5 as `postgres`.

Free projects pause after about a week without activity. A paused project has to be restored
from the Supabase dashboard before the API can connect again.

## Northflank

Three resources in one project, all built from this repository with build type **Dockerfile**,
Dockerfile path `/Dockerfile`, build context `/`. The free Developer Sandbox allows two services
and two jobs, which is exactly this.

| Resource | Type | Command override | Port | Health check |
|---|---|---|---|---|
| `ratchet-api` | combined service | none (image default) | 3000, HTTP, public | HTTP `GET /health` on 3000 |
| `ratchet-worker` | combined service | `node packages/api/dist/pipeline/worker.js` | none | none |
| `ratchet-migrate` | manual job | `node packages/api/dist/migrate.js` | none | none |

Put the variables from the table above in a secret group and attach it, or set them per resource.
Keep both services in the same region, close to the Supabase project (`us-east-1`).

Migrations do not run on service start, so replicas never race each other. Run the
`ratchet-migrate` job before releasing a build that adds a migration. It is forward-only and
idempotent: a run with nothing to apply prints `skip` for every file. Northflank can chain this
in a [release flow](https://northflank.com/docs/v1/application/release/run-migrations) so the
services are only promoted when the job succeeds.

WebSockets need no extra configuration: subscriptions share the API's HTTP port at `/graphql`.

## Cutover

1. Supabase: connection strings in place, `ratchet_app` password set, demo seeded.
2. Upstash: confirm the database still exists. Free databases are archived after a period of
   inactivity and this one has been idle since the Railway services stopped.
3. Northflank: create the three resources, run `ratchet-migrate`, deploy the API, then the worker.
4. Vercel: set `VITE_API_URL` to the Northflank API origin and redeploy.
5. Northflank: confirm `CORS_ORIGINS` is exactly the console origin
   (`https://ratchet-project-web.vercel.app`), then verify with the checklist below.
6. Only then remove Railway (last section).

### Verify the deployed system

A green deploy and a 200 from `/health` prove nothing here: `/health` does not touch the
database. Check each of these.

- `ratchet-migrate` log shows twelve `skip` lines and exits 0.
- `GET /db-check` returns 200. This is the first proof the API reached Supabase as `ratchet_app`
  over verified TLS.
- In the SQL editor, `select usename, count(*) from pg_stat_activity where datname = 'postgres' group by 1`
  shows the API connected as `ratchet_app`, not `postgres`.
- Post an `application.submitted` event with `payload.amount` over 500000. Two tasks (R1, R2)
  appear in the console within two seconds, without a refresh, and both have an assignee.
- Post the same event again with the same idempotency key: 200 with `duplicate: true`, and still
  two tasks.
- The console's network tab shows a WebSocket to `/graphql` with status 101.
- `curl -i -X OPTIONS <api>/graphql -H 'Origin: https://example.com'` returns no
  `access-control-allow-origin` header.
- Restart the worker from Northflank. Its log shows `worker shutting down` then
  `pipeline worker started`, and an event posted afterwards still becomes a task.
- After a few minutes the worker log has no `worker iteration failed` lines. The scheduled sweep
  and the outbox redrive run every 60 seconds and use `ADMIN_DATABASE_URL`, so a bad admin URL
  shows up here and nowhere else.

Do not run the 1,000 events/sec k6 test against the free tiers. A short run at a low rate is
enough to confirm the path: `k6 run -e RATE=20 -e DURATION=15s load/ingest.js`.

## Known costs of the free tiers

- **Upstash command quota.** An idle worker issues one `XREADGROUP` every 500 ms
  (`IDLE_SLEEP_MS` in `pipeline/backoff.ts`), about 173,000 commands a day. Upstash's free tier
  allows 500,000 a month, so an always-on worker exhausts it in roughly three days. Either use
  Upstash pay-as-you-go, or scale the worker to zero when the demo is not being shown.
- **Supabase pausing**, above.

## What has been verified

Locally, against the built image and docker-compose Postgres and Redis:

- `docker build` succeeds; the runtime image has production dependencies only and runs as `node`.
- The migrate command, the API and the worker all start from the one image.
- Ingest to task end to end in under a second, with routing; exactly two tasks after a duplicate
  post; 409 on a reused idempotency key with a different body; subscription pushes over
  WebSocket; CORS and WebSocket origin allowlist; graceful shutdown on SIGTERM for both
  processes; both recover after Postgres and Redis are stopped and restarted.
- The full test suites: API 79/79 on a fresh database, SDK 7/7, web 24/24.

On the Supabase project:

- All twelve migrations recorded once in `schema_migrations`.
- Every tenant table has RLS enabled and forced, with a policy. Supabase's security advisor
  reports nothing.
- As `ratchet_app`: no rows visible without a tenant context, only its own rows with one, a
  cross-tenant insert is rejected, and `ratchet_authenticate` resolves a key.
- `ratchet_app` is not a superuser, has no `BYPASSRLS`, owns nothing, and the Data API roles
  have no grants on any Ratchet table.
- The pooler's certificate verifies against the bundled CA, including the hostname.

Not yet verified, because they need the real connection strings or the Northflank services:

- A real `pg` login through the session pooler. In particular `db.ts` sends `statement_timeout`
  and `idle_in_transaction_session_timeout` as connection startup parameters, and some poolers
  reject those. If the first connection fails with an unsupported-parameter error, that is why.
- Everything in [Verify the deployed system](#verify-the-deployed-system).

## Removing Railway

After the checklist above passes:

- [ ] Delete `packages/api/railway.json` and `packages/api/railway.worker.json`.
- [ ] Update the comment in `packages/api/tsconfig.ops.json` that refers to `railway.json`.
- [ ] Remove the Railway section from `CLAUDE.md`.
- [ ] Delete the Railway project, including its Postgres volume. Nothing in it is needed: the
      Supabase database was rebuilt from migrations and the demo seed.
- [ ] Remove the `claude-code-ratchet` SSH key from Railway (`railway ssh keys remove`).
