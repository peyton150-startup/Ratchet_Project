# Ratchet

A multi-tenant task orchestration platform. Client systems post entity change events. Ratchet evaluates versioned rules against each one, and when a rule matches it creates a routed, SLA-tracked task that operators work in a console.

The problem it solves: in multi-step operational processes like loan origination or claims handling, the next action often lives in someone's head, and work stalls when they miss it. Ratchet creates that action automatically the moment the data changes.

## What is interesting here

- **Exactly-once task creation** per `(event, rule)` pair, proven by an automated duplicate-storm test in CI. Delivery is at-least-once; deduplication at the task boundary is what makes that safe.
- **Transactional outbox** rather than a message broker. The event row and the dispatch row commit in one transaction, so the dual-write problem cannot occur. A relay pushes to Redis Streams. ([ADR-001](docs/adr/ADR-001-outbox-vs-broker.md))
- **A rules engine that queries current state**, not just the incoming event. One demo rule spans multiple entities, one fires only on a specific field delta, and one is time-triggered with no event at all. Those three requirements shaped the whole DSL. ([ADR-004](docs/adr/ADR-004-rules-dsl-shape.md))
- **Tenant isolation enforced by Postgres**, with forced row-level security and a CI invariant asserting every tenant table has a policy. A missing policy leaks silently, so it is not left to convention. ([ADR-005](docs/adr/ADR-005-multi-tenancy-isolation.md))
- **One transition table** for the task state machine, shared by the API, the consoles, and the SDK, so they cannot drift.
- **Integration tests against real Postgres and Redis**, not mocks.

## Stack

TypeScript throughout. Node and Express for the API, React for the consoles, Postgres for the event log and application state, Redis for streams, caching, and pub/sub. GraphQL for the consoles, REST plus signed webhooks for integrators. pnpm workspaces.

```
packages/api      ingest, rules engine, task service, pipeline, webhooks, GraphQL
packages/web      operator and admin consoles
packages/sdk      shared domain module and typed client
packages/workers  placeholder; the runnable pipeline worker is packages/api/src/pipeline/worker.ts
load/             k6 load test proving the throughput SLO
docs/             design doc, scope statement, demo domain, ADRs
```

## Running it

```bash
docker compose up -d          # Postgres and Redis
pnpm install
pnpm -r build
pnpm --filter @workspace/api migrate
pnpm --filter @workspace/api dev
```

Seed the demo domain, a loan origination pipeline with twelve rules:

```bash
pnpm --filter @workspace/api seed
```

Issue an API key to post events:

```bash
pnpm --filter @workspace/api issue-key -- --tenant demo --role integrator
```

The key is generated and printed once. For local testing you can pin a memorable one with
`--key` instead — re-running with the same `--key` is safe. Never do this against a database
holding real data; a guessable key is a live credential for that tenant.

```bash
pnpm --filter @workspace/api issue-key -- --tenant demo --role integrator --key 123456789
```

Both forms use `tsx`, which is a devDependency and so is absent from the deployed image. The
script is also compiled (`tsconfig.ops.json`) so keys can be issued and rotated on Railway with
plain node — `postgres.railway.internal` only resolves inside Railway, so this has to run there
rather than from a laptop:

```bash
railway ssh --service "@workspace/api" -- \
  node packages/api/dist/scripts/issueKey.js --tenant demo --role admin
```

## Deployment

The two halves deploy separately: the consoles are a static bundle with no server, and the API is a long-lived process with a database, so they do not belong on the same platform.

| | Platform | Notes |
|---|---|---|
| `packages/web` | Vercel — project `ratchet-project-web` | Vite preset, root directory `packages/web`, **"Include files outside the root directory" enabled** so the `@workspace/sdk` workspace dependency resolves |
| `packages/api` | Railway — service `@workspace/api` | config in [`packages/api/railway.json`](packages/api/railway.json) |
| pipeline worker | Railway — service `@workspace/workers` | config in [`packages/api/railway.worker.json`](packages/api/railway.worker.json); runs the API package's worker entrypoint |
| Postgres | Railway | private networking only, no public proxy |
| Redis | Upstash | requires TLS, so the URL scheme is `rediss://`, not `redis://` |

Build order matters on both platforms: `@workspace/sdk` must be built before `@workspace/api` or `@workspace/web`, because both resolve it through `dist/`. Building only the leaf package fails with `TS2307: Cannot find module '@workspace/sdk'`.

Migrations run automatically as a Railway pre-deploy step (`node packages/api/dist/migrate.js`). The runner is compiled rather than invoked through `tsx`, because `tsx` is a devDependency and is not guaranteed to exist in a deployed image. It is forward-only and idempotent, tracked in `schema_migrations`.

Environment variables that must be set, beyond what each platform injects:

| Variable | Where | Notes |
|---|---|---|
| `VITE_API_URL` | Vercel | baked in at build time, so changing it requires a redeploy |
| `DATABASE_URL` | Railway api + workers | the least-privilege `ratchet_app` role — **not** the `postgres` superuser, which bypasses row-level security and would silently disable tenant isolation |
| `ADMIN_DATABASE_URL` | Railway api + workers | superuser; migrations create roles and set `FORCE` RLS |
| `REDIS_URL` | Railway api + workers | `rediss://` |
| `CORS_ORIGINS` | Railway api | comma-separated; an unset value disables cross-origin access entirely. Must list every origin the consoles are served from |

`CORS_ORIGINS` also governs the WebSocket handshake, since CORS does not apply to WebSockets and the subscription endpoint enforces the same allowlist at `verifyClient`.

## Testing

```bash
pnpm -r exec tsc --noEmit
pnpm --filter @workspace/api test    # integration, against real Postgres and Redis
pnpm --filter @workspace/sdk test
pnpm --filter @workspace/web test
```

CI runs all of it on every push and every pull request, including stacked ones.

The three tests worth reading: the duplicate storm in `pipeline.test.ts`, the illegal transition cases in `tasks.test.ts`, and the cross-tenant isolation assertions in `rls.test.ts`.

## Load testing

```bash
BASE_URL=https://staging.example API_KEY=rk_xxx \
  k6 run -e RATE=1000 -e DURATION=60s -e INGEST_P95_MS=200 load/ingest.js
```

Target is 1,000 events/sec sustained with p95 ingest latency under 200 ms. Run the generator from a separate machine, or the numbers are meaningless. Details in [load/README.md](load/README.md).

## Documentation

- [Design doc](docs/design.md) — architecture, data model, key flows, failure modes
- [Scope statement](docs/scope.md) — objectives, acceptance criteria, exclusions
- [Demo domain](docs/demo-domain.md) — the loan pipeline, its entities, events, and twelve rules
- [ADRs](docs/adr/) — the five decisions the system inherits

## A note on how this was built

Solo, with two AI models used deliberately for different work. The cheaper model wrote scaffolding, CRUD, consoles, and test boilerplate. The stronger model wrote the design doc, the ADRs, and the correctness kernel: outbox and idempotency, the task state machine, the rules engine, auth and row-level security, and retry and concurrency logic. It also reviewed every kernel PR the other model wrote.

The rule was: the cheaper model writes what tests can catch, the stronger model writes what tests might miss. Every PR is labeled with its author model, so the split is visible in the history.
