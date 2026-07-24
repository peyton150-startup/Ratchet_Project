// Ratchet ingest load test (scope §Objectives: "1,000 events/sec sustained in a k6 run with p95
// ingest latency under target"). Holds a fixed arrival rate against POST /events and asserts the
// latency + error thresholds. Because every accepted event flows event -> outbox -> stream ->
// consumer -> task, a sustained run here is also the real-world stress test for the exactly-once
// pipeline and the outbox redrive (Fix A) under backlog.
//
// Run from a SEPARATE machine from the server (co-locating skews the numbers — see docs/scope.md).
//
//   BASE_URL=https://staging.example \
//   API_KEY=rk_xxx \
//   k6 run -e RATE=1000 -e DURATION=60s -e INGEST_P95_MS=200 load/ingest.js
//
// Env:
//   BASE_URL        target base URL (default http://localhost:3000)
//   API_KEY         an events:ingest key (issue with `pnpm --filter @workspace/api issue-key`)
//   RATE            events per second to sustain (default 1000)
//   DURATION        how long to hold the rate (default 60s)
//   INGEST_P95_MS   p95 latency threshold in ms; the run FAILS if exceeded (default 200)
//   DUP_RATIO       fraction [0..1] of requests that reuse a key to exercise dedup (default 0)
//   RUN_ID          salt so re-runs create fresh events (default: start timestamp)

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = __ENV.API_KEY || '';
const RATE = Number(__ENV.RATE || 1000);
const DURATION = __ENV.DURATION || '60s';
const P95 = Number(__ENV.INGEST_P95_MS || 200);
const DUP_RATIO = Number(__ENV.DUP_RATIO || 0);
const RUN_ID = __ENV.RUN_ID || String(Date.now());

// A representative slice of the catalog (packages/sdk/src/domain.ts).
const EVENT_TYPES = [
  'application.submitted',
  'application.updated',
  'document.uploaded',
  'verification.completed',
  'condition.created',
];

const created = new Counter('ingest_created'); // 201
const duplicates = new Counter('ingest_duplicates'); // 200
const rateLimited = new Counter('ingest_rate_limited'); // 429
const failures = new Counter('ingest_failures'); // anything else

export const options = {
  scenarios: {
    ingest: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Headroom so the executor can keep the rate even when latency rises; k6 warns if too low.
      preAllocatedVUs: Math.max(200, Math.ceil(RATE / 4)),
      maxVUs: Math.max(1000, RATE),
    },
  },
  thresholds: {
    // The headline SLO: p95 ingest latency under target at the sustained rate.
    'http_req_duration{scenario:ingest}': [`p(95)<${P95}`],
    // Correctness under load: essentially no failed requests and no rate-limiting at the target rate.
    http_req_failed: ['rate<0.01'],
    ingest_rate_limited: ['count<1'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  if (!API_KEY) throw new Error('API_KEY is required (an events:ingest key)');
  return {};
}

export default function () {
  const type = EVENT_TYPES[(__VU + __ITER) % EVENT_TYPES.length];
  // Most requests are unique events; a DUP_RATIO fraction reuse a key to prove dedup returns 200
  // (not an error) under load — exactly-once must hold even in a storm.
  const isDup = DUP_RATIO > 0 && Math.random() < DUP_RATIO;
  const idempotencyKey = isDup ? `dup-${RUN_ID}` : `${RUN_ID}-${__VU}-${__ITER}`;

  const body = JSON.stringify({
    idempotencyKey,
    type,
    entityId: `ent-${RUN_ID}-${__VU}-${__ITER % 1000}`,
    payload: { amount: 100, source: 'k6' },
  });

  const res = http.post(`${BASE_URL}/events`, body, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    tags: { name: 'ingest' },
  });

  if (res.status === 201) created.add(1);
  else if (res.status === 200) duplicates.add(1);
  else if (res.status === 429) rateLimited.add(1);
  else failures.add(1);

  check(res, {
    'accepted (200/201)': (r) => r.status === 200 || r.status === 201,
    'not rate limited': (r) => r.status !== 429,
  });
}
