# Deploying Ratchet

```
Vercel      ratchet-project-web   operator and admin consoles (static bundle)
Northflank  ratchet-api           node packages/api/dist/index.js
Northflank  ratchet-worker        node packages/api/dist/pipeline/worker.js
Northflank  ratchet-project-redis Redis addon: streams, pub/sub, cache (private to the project)
Supabase    ratchet               Postgres, used as plain Postgres over `pg`
```

The API and the worker are one image ([`Dockerfile`](../Dockerfile)) started with different
commands. They stay separate processes: the worker is a continuous loop, not a request handler,
and must be an always-on service. Supabase is only a database here: no Supabase APIs, Auth or
client library.

- Console: `https://ratchet-project-web.vercel.app`
- API: `https://http--ratchet-api--qljn8m82hxbx.code.run`

Everything runs inside free tiers: Northflank's Developer Sandbox (two services, one addon, two
jobs) and Supabase's free plan.

## Northflank

Project `ratchet`, region `us-central`. The US East region does not allow free projects, so the
services sit one region away from the Supabase database in `us-east-1`.

| Resource | Type | Plan | Command | Port | Health check |
|---|---|---|---|---|---|
| `ratchet-api` | combined service | `nf-compute-10`, 1 instance | image default | 3000, HTTP, public | readiness, HTTP `GET /health` |
| `ratchet-worker` | combined service | `nf-compute-10`, 1 instance | `node packages/api/dist/pipeline/worker.js` | none | none |
| `ratchet-project-redis` | Redis addon | `nf-compute-20`, 6 GB, 1 replica | | private, TLS | |

Both services build from `main` with build type Dockerfile, path `/Dockerfile`, context `/`.

The Redis addon must keep `maxmemory-policy` at `noeviction` (its current value). The event
stream lives there, and any other policy lets Redis drop entries when memory fills. Entries lost
that way are re-delivered from the Postgres outbox after five minutes, so the failure would show
up as slow tasks, not missing ones.

### Environment

Variables come from three secret groups. Splitting them is what keeps the admin connection away
from the API.

| Secret group | Applies to | Variables |
|---|---|---|
| `ratchet-shared` | everything in the project | `CORS_ORIGINS`, `PG_POOL_MAX=5`, and `REDIS_URL`, which is linked from the addon (its `REDIS_MASTER_URL`), not typed in |
| `ratchet-db-app` | `ratchet-api`, `ratchet-worker` | `DATABASE_URL` |
| `ratchet-db-admin` | `ratchet-worker` only | `ADMIN_DATABASE_URL` |

| Variable | API | Worker | Notes |
|---|---|---|---|
| `DATABASE_URL` | required | required | The `ratchet_app` role. Never `postgres`: a role with `BYPASSRLS` silently disables tenant isolation |
| `ADMIN_DATABASE_URL` | never | required | The `postgres` role. The worker needs it for the outbox relay, redrive and scheduled sweeps, which are cross-tenant |
| `REDIS_URL` | required | required | `rediss://`, injected from the addon |
| `CORS_ORIGINS` | required | unused | Comma-separated. Also gates the WebSocket handshake. Unset means no cross-origin access at all |
| `PG_POOL_MAX` | `5` | `5` | Default 10. See [Connection budget](#connection-budget) |
| `PORT` | optional | | Defaults to 3000, which is the port the service exposes |

Optional tuning, all with safe defaults: `PG_STATEMENT_TIMEOUT_MS` (10000),
`PG_IDLE_IN_TX_TIMEOUT_MS` (15000), `PG_CONNECT_TIMEOUT_MS` (5000), `LOG_LEVEL`,
`MAX_BODY_SIZE` (256kb), `INGEST_RATE_WINDOW_MS` (1000), `INGEST_RATE_MAX` (2000),
`MAX_SCAN_ROWS`, `WEBHOOK_TIMEOUT_MS`, `RATCHET_STREAM` (`ratchet:events`),
`RATCHET_GROUP` (`rules-workers`). Leave `NODE_EXTRA_CA_CERTS` alone; the image sets it.

Vercel has one: `VITE_API_URL`, the API origin above. It is baked in at build time, so changing
it requires a redeploy.

### Migrations

Migrations never run on service start, so replicas cannot race each other. There is no
migration job yet, because the schema was already current when the services were created.
For a release that adds a migration, run the runner before deploying it. Either:

- run `node packages/api/dist/migrate.js` in a shell on `ratchet-worker`, which has
  `ADMIN_DATABASE_URL` and the new image's `migrations/` directory once it has built; or
- create a manual job from the same repository and Dockerfile with that command, add it to the
  `ratchet-db-admin` secret group, and run it first. The sandbox has two job slots free, and a
  [release flow](https://northflank.com/docs/v1/application/release/run-migrations) can chain it
  ahead of the deploy.

The runner is forward-only and idempotent: a run with nothing to apply prints `skip` for every
file.

### Operating it

- Issue or rotate an API key from a shell on `ratchet-worker` (the API container has no admin
  connection): `node packages/api/dist/scripts/issueKey.js --tenant demo --role admin`.
  The key is printed once and only its hash is stored.
- To pause the pipeline, scale `ratchet-worker` to zero. Events posted meanwhile stay in the
  outbox and are processed when it returns.

## Supabase

Project `ratchet` (`bxefwpmgymklebckoxzz`), `us-east-1`.

### Connection strings

Use the **Session pooler** (port 5432) from the project's Connect dialog. The direct connection
is IPv6-only, and the transaction pooler (port 6543) is not needed: Ratchet holds a small fixed
pool per process.

```
ADMIN_DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full
DATABASE_URL=postgresql://ratchet_app.<PROJECT_REF>:<APP_ROLE_PASSWORD>@<POOLER_HOST>:5432/postgres?sslmode=verify-full
```

The `sslmode` parameter is not optional. Without it `pg` connects in plaintext and the pooler
accepts it, so credentials and tenant data cross the internet unencrypted with nothing reporting
a problem. With it, `pg` verifies the certificate chain and hostname against Supabase's CA, which
the image trusts through `packages/api/certs/supabase-root-2021-ca.crt`. Outside the image, set
`NODE_EXTRA_CA_CERTS` to that file or the connection fails with `SELF_SIGNED_CERT_IN_CHAIN`.

`sslmode=require` currently behaves the same as `verify-full`, and the deployed values use it.
The next major version of `pg` will make `require` stop verifying the server, so move to
`verify-full` before upgrading `pg`.

### New project

1. Run [`packages/api/scripts/supabase/bootstrap.sql`](../packages/api/scripts/supabase/bootstrap.sql)
   in the SQL editor. It must run before the first migration; the file explains why.
2. Run the migrations.
3. Run [`set-app-role-password.sql`](../packages/api/scripts/supabase/set-app-role-password.sql)
   in the SQL editor and put the password it returns into `DATABASE_URL`. Re-running it rotates
   the password.
4. Seed the demo and issue a key. From a laptop, with `ADMIN_DATABASE_URL` and
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
value). At the default `PG_POOL_MAX` of 10, the API and the worker can together ask for 20
connections as `ratchet_app`. With `PG_POOL_MAX=5` the total is 10 as `ratchet_app` and 5 as
`postgres`.

Free projects pause after about a week without activity. A paused project has to be restored
from the Supabase dashboard before the API can connect again.

## Verifying a deployment

A green deploy and a 200 from `/health` prove nothing here: `/health` does not touch the
database. Check each of these.

- `GET /db-check` returns 200. This proves the API reached Supabase over verified TLS.
- In the Supabase SQL editor,
  `select usename, count(*) from pg_stat_activity where datname = 'postgres' group by 1`
  shows the API's connections as `ratchet_app`. If they are all `postgres`, `DATABASE_URL` holds
  the admin string and tenant isolation is off, while `/health` and `/db-check` still pass.
- Post an `application.submitted` event with `payload.amount` over 500000. Two tasks (R1, R2)
  appear in the console within two seconds, without a refresh, and both have an assignee.
- Post the same event again with the same idempotency key: 200 with `duplicate: true`, and still
  two tasks.
- The console's network tab shows a WebSocket to `/graphql` with status 101.
- `curl -i -X OPTIONS <api>/graphql -H 'Origin: https://example.com'` returns no
  `access-control-allow-origin` header.
- After a few minutes the worker log has no `worker iteration failed` lines. The scheduled sweep
  and the outbox redrive run every 60 seconds and use `ADMIN_DATABASE_URL`, so a bad admin URL
  shows up here and nowhere else.

Do not run the 1,000 events/sec k6 test against the free tiers. A short run at a low rate is
enough to confirm the path: `k6 run -e RATE=20 -e DURATION=15s load/ingest.js`.

## What has been verified

On the live system, 2026-10-02:

- `/health` and `/db-check` return 200; Supabase shows the API connected as `ratchet_app`.
- A posted `application.submitted` event was relayed from the outbox in 243 ms and became two
  tasks (R1 in intake, R2 in underwriting) 587 ms after ingest, each routed to an agent, with
  the outbox row marked consumed and nothing dead-lettered.
- A bad API key is rejected with 401. The console origin gets CORS headers; another origin gets
  none.
- The worker ran through its scheduled sweep and redrive without errors, so the admin connection
  works. Supabase's pooler accepts the `statement_timeout` and
  `idle_in_transaction_session_timeout` startup parameters that `db.ts` sends.
- Redis reports `maxmemory-policy noeviction`, and the worker's consumer group exists on the
  stream.
- The live console bundle contains the Northflank API origin.
- Northflank's hourly usage entries price the builds, both services and the addon at $0.

On the Supabase project:

- All twelve migrations recorded once in `schema_migrations`.
- Every tenant table has RLS enabled and forced, with a policy. Supabase's security advisor
  reports nothing.
- As `ratchet_app`: no rows visible without a tenant context, only its own rows with one, a
  cross-tenant insert is rejected, and `ratchet_authenticate` resolves a key.
- `ratchet_app` is not a superuser, has no `BYPASSRLS`, and the Data API roles have no grants on
  any Ratchet table.

Locally, against the built image and docker-compose Postgres and Redis:

- Exactly two tasks after a duplicate post, 409 on a reused idempotency key with a different
  body, subscription pushes over WebSocket, the WebSocket origin allowlist, graceful shutdown on
  SIGTERM for both processes, and recovery after Postgres and Redis are stopped and restarted.
- The full test suites: API 79/79 on a fresh database, SDK 7/7, web 24/24.

Not verified on the live system:

- The console in a browser, including the WebSocket subscription.
- A duplicate post, SIGTERM handling and outage recovery. These were only exercised locally.
- Whether services pick up a changed secret group without a manual restart.
- Any load test.
