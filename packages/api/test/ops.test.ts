import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkWebhookUrl, isBlockedAddress, type Resolver } from '../src/webhooks/urlGuard';
import { nextLoopState, IDLE_SLEEP_MS, MAX_BACKOFF_MS } from '../src/pipeline/backoff';
import { renderMetrics, metrics } from '../src/observability';
import { buildApp } from '../src/app';
import { adminPool, appPool, seedTenant, startServer, postEvent, type RunningServer } from './helpers';

let server: RunningServer;

before(async () => {
  server = await startServer(buildApp(appPool));
});

after(async () => {
  await server.close();
  await appPool.end();
  await adminPool.end();
});

// ---- SSRF guard ------------------------------------------------------------------------------

const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolver: Resolver = async () => [{ address: '169.254.169.254', family: 4 }];

test('blocks private, loopback and link-local addresses', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '0.0.0.0']) {
    assert.equal(isBlockedAddress(ip, 4), true, `${ip} should be blocked`);
  }
  assert.equal(isBlockedAddress('93.184.216.34', 4), false, 'public address allowed');
  assert.equal(isBlockedAddress('::1', 6), true, 'IPv6 loopback blocked');
  assert.equal(isBlockedAddress('fd00::1', 6), true, 'IPv6 unique-local blocked');
  assert.equal(isBlockedAddress('::ffff:127.0.0.1', 6), true, 'IPv4-mapped loopback blocked');
});

test('checkWebhookUrl rejects cloud metadata and non-http schemes', async () => {
  const metadata = await checkWebhookUrl('http://169.254.169.254/latest/meta-data/', privateResolver);
  assert.equal(metadata.ok, false);
  assert.match(metadata.reason!, /private or reserved/);

  const fileUrl = await checkWebhookUrl('file:///etc/passwd', publicResolver);
  assert.equal(fileUrl.ok, false);
  assert.match(fileUrl.reason!, /http/);

  const ok = await checkWebhookUrl('https://example.com/hook', publicResolver);
  assert.equal(ok.ok, true);
});

test('registering a webhook with a private URL is rejected', async () => {
  const t = await seedTenant('ssrf');
  const res = await fetch(`${server.url}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.rawKey}` },
    body: JSON.stringify({ url: 'http://127.0.0.1:5432/hook', events: ['task.created'] }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /rejected/);
});

// ---- worker backoff --------------------------------------------------------------------------

test('failures back off exponentially and success resets', () => {
  const fail = { ok: false, didWork: false };
  const s1 = nextLoopState(0, fail);
  const s2 = nextLoopState(s1.consecutiveFailures, fail);
  const s3 = nextLoopState(s2.consecutiveFailures, fail);
  assert.ok(s2.backoffMs > s1.backoffMs && s3.backoffMs > s2.backoffMs, 'backoff grows');

  // Capped, so a long outage never produces an absurd sleep.
  let state = { consecutiveFailures: 20, backoffMs: 0 };
  state = nextLoopState(state.consecutiveFailures, fail);
  assert.equal(state.backoffMs, MAX_BACKOFF_MS);

  // Any success clears the penalty — otherwise one blip degrades the pipeline forever.
  const recovered = nextLoopState(5, { ok: true, didWork: true });
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.backoffMs, 0);

  // Idle (no work, no error) waits the normal poll interval.
  assert.equal(nextLoopState(0, { ok: true, didWork: false }).backoffMs, IDLE_SLEEP_MS);
});

// ---- metrics + limits ------------------------------------------------------------------------

test('metrics endpoint renders Prometheus text', async () => {
  metrics.eventsIngested.inc({ duplicate: 'false' });
  const res = await fetch(`${server.url}/metrics`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /# TYPE ratchet_events_ingested_total counter/);
  assert.match(body, /ratchet_http_request_seconds_bucket/);
  assert.ok(renderMetrics().length > 0);
});

test('rate limiting rejects a burst beyond the window', async () => {
  const t = await seedTenant('ratelimit');
  const limited = await startServer(
    buildApp(appPool, undefined, undefined, { ingestRateLimit: { windowMs: 60_000, max: 2 } }),
  );
  try {
    const body = { type: 'application.submitted', entityId: 'a-1' };
    const first = await postEvent(limited.url, t.rawKey, { ...body, idempotencyKey: 'rl-1' });
    const second = await postEvent(limited.url, t.rawKey, { ...body, idempotencyKey: 'rl-2' });
    const third = await postEvent(limited.url, t.rawKey, { ...body, idempotencyKey: 'rl-3' });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(third.status, 429, 'third request exceeds the limit');
  } finally {
    await limited.close();
  }
});

test('an oversized body is rejected rather than processed', async () => {
  const t = await seedTenant('bodysize');
  const huge = 'x'.repeat(400_000); // over the 256kb default
  const res = await fetch(`${server.url}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.rawKey}` },
    body: JSON.stringify({ idempotencyKey: 'big', type: 'application.submitted', entityId: huge }),
  });
  assert.ok(res.status === 413 || res.status === 400, `expected rejection, got ${res.status}`);
});
