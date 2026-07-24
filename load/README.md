# Load tests (k6)

Proves the scope SLO: **1,000 events/sec sustained with p95 ingest latency under target.**
`ingest.js` holds a fixed arrival rate against `POST /events` and fails the run if p95 latency,
error rate, or rate-limiting breach their thresholds. Because every accepted event flows
`event → outbox → stream → consumer → task`, a sustained run is also the real stress test for the
exactly-once pipeline and the outbox redrive under backlog.

## Prerequisites

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed on the load-generating host.
- An `events:ingest` API key:
  ```bash
  pnpm --filter @workspace/api issue-key -- --tenant "loadtest" --role integrator
  ```
- The API + worker + Postgres + Redis running against a realistic environment (staging).

## Run

Run from a **separate machine** from the server — co-locating the generator and the app skews the
numbers (docs/scope.md). Publish the server specs (CPU/RAM, Postgres/Redis sizing) alongside results.

```bash
BASE_URL=https://staging.example \
API_KEY=rk_xxxxxxxx \
k6 run -e RATE=1000 -e DURATION=60s -e INGEST_P95_MS=200 load/ingest.js
```

### Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `BASE_URL` | `http://localhost:3000` | Target base URL |
| `API_KEY` | — (required) | An `events:ingest` key |
| `RATE` | `1000` | Events per second to sustain |
| `DURATION` | `60s` | How long to hold the rate |
| `INGEST_P95_MS` | `200` | p95 latency threshold (ms); run FAILS if exceeded |
| `DUP_RATIO` | `0` | Fraction `[0..1]` of requests that reuse a key to exercise dedup |
| `RUN_ID` | start timestamp | Salt so re-runs create fresh events |

> **Proposed p95 target:** `200ms` at 1,000 ev/s fills the `[fill in]` in `docs/scope.md §Objectives`.
> Tune it against real hardware, then record the agreed number in the scope statement.

## What "pass" means

- `http_req_duration{scenario:ingest} p(95) < INGEST_P95_MS`
- `http_req_failed rate < 1%` and `ingest_rate_limited count == 0` (the default 2000/s per-tenant
  limit leaves headroom at 1,000/s; raise `INGEST_RATE_MAX` on the server if you push higher)
- `checks rate > 99%`

Custom counters in the summary: `ingest_created` (201), `ingest_duplicates` (200),
`ingest_rate_limited` (429), `ingest_failures` (other).

## Verifying the pipeline kept up

After a run, confirm the backlog drained and exactly-once held:

```sql
-- pending outbox should trend to ~0 shortly after the run ends
SELECT status, count(*) FROM outbox GROUP BY status;
-- redrive should be rare/zero on a healthy run
-- (watch ratchet_outbox_redriven_total on /metrics)
```
