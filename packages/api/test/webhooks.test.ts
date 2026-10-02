import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signBody, verifySignature, SIGNATURE_HEADER } from '../src/webhooks/signing';
import { WebhookDispatcher, type Sender } from '../src/webhooks/dispatcher';
import type { Resolver } from '../src/webhooks/urlGuard';

// The SSRF guard resolves webhook hostnames; stub it so tests need no real DNS.
const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];
import { buildApp } from '../src/app';
import {
  adminPool,
  appPool,
  seedTenant,
  seedKey,
  startServer,
  type RunningServer,
} from './helpers';

let server: RunningServer;

before(async () => {
  server = await startServer(buildApp(appPool, undefined, undefined, { webhookResolver: publicResolver }));
});

after(async () => {
  await server.close();
  await appPool.end();
  await adminPool.end();
});

async function seedWebhook(tenantId: string, url: string, events: string[], secret = 'shh'): Promise<string> {
  const r = await adminPool.query<{ id: string }>(
    'INSERT INTO webhooks (tenant_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenantId, url, secret, events],
  );
  return r.rows[0]!.id;
}

// A capturing sender for the dispatcher.
function capturingSender(status = 200): { sender: Sender; calls: Array<{ url: string; headers: Record<string, string>; body: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const sender: Sender = async (url, req) => {
    calls.push({ url, headers: req.headers, body: req.body });
    return { status };
  };
  return { sender, calls };
}

test('signing round-trips and rejects tampering / staleness', () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);
  const header = signBody('secret', '{"a":1}', ts);
  assert.equal(verifySignature('secret', '{"a":1}', header, { nowMs: now }), true);
  assert.equal(verifySignature('secret', '{"a":2}', header, { nowMs: now }), false, 'tampered body');
  assert.equal(verifySignature('wrong', '{"a":1}', header, { nowMs: now }), false, 'wrong secret');
  assert.equal(
    verifySignature('secret', '{"a":1}', header, { nowMs: now + 10 * 60 * 1000 }),
    false,
    'stale timestamp',
  );
});

test('dispatch delivers a valid signature to matching webhooks', async () => {
  const t = await seedTenant('wh-deliver');
  await seedWebhook(t.tenantId, 'https://example.test/hook', ['task.created'], 'topsecret');
  const { sender, calls } = capturingSender(200);
  const dispatcher = new WebhookDispatcher(appPool, { maxAttempts: 3, baseDelayMs: 0 }, sender, undefined, publicResolver);

  const n = await dispatcher.dispatch(t.tenantId, 'task.created', { id: 'task-1' });
  assert.equal(n, 1);
  assert.equal(calls.length, 1);
  // The delivered body must verify against the webhook secret.
  const sig = calls[0]!.headers[SIGNATURE_HEADER]!;
  assert.equal(verifySignature('topsecret', calls[0]!.body, sig), true);

  const del = await adminPool.query<{ status: string }>(
    'SELECT status FROM webhook_deliveries WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(del.rows[0]!.status, 'delivered');
});

test('dispatch only fires webhooks subscribed to the event type', async () => {
  const t = await seedTenant('wh-filter');
  await seedWebhook(t.tenantId, 'https://example.test/hook', ['task.updated']); // not task.created
  const { sender, calls } = capturingSender(200);
  const dispatcher = new WebhookDispatcher(appPool, { maxAttempts: 3, baseDelayMs: 0 }, sender, undefined, publicResolver);

  const n = await dispatcher.dispatch(t.tenantId, 'task.created', { id: 'x' });
  assert.equal(n, 0);
  assert.equal(calls.length, 0);
});

test('dispatch retries then records failure for a failing endpoint', async () => {
  const t = await seedTenant('wh-fail');
  await seedWebhook(t.tenantId, 'https://example.test/down', ['task.created']);
  const { sender, calls } = capturingSender(500);
  const dispatcher = new WebhookDispatcher(appPool, { maxAttempts: 3, baseDelayMs: 0 }, sender, async () => {}, publicResolver);

  await dispatcher.dispatch(t.tenantId, 'task.created', { id: 'x' });
  assert.equal(calls.length, 3, 'retried maxAttempts times');

  const del = await adminPool.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM webhook_deliveries WHERE tenant_id = $1',
    [t.tenantId],
  );
  assert.equal(del.rows[0]!.status, 'failed');
  assert.equal(del.rows[0]!.attempts, 3);
});

test('dispatch is tenant-isolated', async () => {
  const a = await seedTenant('wh-a');
  const b = await seedTenant('wh-b');
  await seedWebhook(a.tenantId, 'https://example.test/a', ['task.created']);
  const { sender, calls } = capturingSender(200);
  const dispatcher = new WebhookDispatcher(appPool, { maxAttempts: 1, baseDelayMs: 0 }, sender, undefined, publicResolver);

  const n = await dispatcher.dispatch(b.tenantId, 'task.created', { id: 'x' });
  assert.equal(n, 0, 'tenant B sees none of tenant A webhooks');
  assert.equal(calls.length, 0);
});

test('REST: register and list webhooks (webhooks:manage)', async () => {
  const t = await seedTenant('wh-rest');
  // Register with the default admin key.
  const reg = await fetch(`${server.url}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.rawKey}` },
    body: JSON.stringify({ url: 'https://example.test/hook', events: ['task.created'] }),
  });
  assert.equal(reg.status, 201);
  const created = (await reg.json()) as { id: string; secret: string };
  assert.ok(created.id && created.secret, 'returns id + secret once');

  const list = await fetch(`${server.url}/webhooks`, {
    headers: { authorization: `Bearer ${t.rawKey}` },
  });
  assert.equal(list.status, 200);
  const rows = (await list.json()) as Array<{ id: string; secret?: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.secret, undefined, 'list never exposes the secret');

  // An operator lacks webhooks:manage.
  const opKey = await seedKey(t.tenantId, 'operator');
  const forbidden = await fetch(`${server.url}/webhooks`, { headers: { authorization: `Bearer ${opKey}` } });
  assert.equal(forbidden.status, 403);
});

test('REST: a webhook can be paused and resumed, and a paused one is not called', async () => {
  const t = await seedTenant('wh-pause');
  const id = await seedWebhook(t.tenantId, 'https://example.test/hook', ['task.created']);
  const patch = (target: string, body: unknown, key = t.rawKey): Promise<Response> =>
    fetch(`${server.url}/webhooks/${target}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

  const paused = await patch(id, { active: false });
  assert.equal(paused.status, 200);
  assert.deepEqual(await paused.json(), {
    id,
    url: 'https://example.test/hook',
    events: ['task.created'],
    active: false,
  });

  const { sender, calls } = capturingSender(200);
  const dispatcher = new WebhookDispatcher(appPool, { maxAttempts: 1, baseDelayMs: 0 }, sender, undefined, publicResolver);
  assert.equal(await dispatcher.dispatch(t.tenantId, 'task.created', { id: 'x' }), 0);
  assert.equal(calls.length, 0, 'a paused webhook is not called');

  assert.equal((await patch(id, { active: true })).status, 200);
  assert.equal(await dispatcher.dispatch(t.tenantId, 'task.created', { id: 'x' }), 1);

  // Rejections: a bad body, an id that is not a uuid, an unknown id, another tenant's webhook.
  assert.equal((await patch(id, { active: 'no' })).status, 400);
  assert.equal((await patch('not-a-uuid', { active: false })).status, 404);
  assert.equal((await patch(randomUUID(), { active: false })).status, 404);
  const other = await seedTenant('wh-pause-other');
  assert.equal((await patch(id, { active: false }, other.rawKey)).status, 404, 'tenant-isolated');
});

test('REST: deliveries lists what was sent to one webhook, newest first', async () => {
  const t = await seedTenant('wh-deliveries');
  const id = await seedWebhook(t.tenantId, 'https://example.test/hook', ['task.created']);
  const otherHook = await seedWebhook(t.tenantId, 'https://example.test/other', ['task.created']);
  await adminPool.query(
    `INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_type, payload, status, attempts, response_status, created_at)
     VALUES ($1, $2, 'task.created', '{}', 'failed',    3, 500, now() - interval '1 hour'),
            ($1, $2, 'task.created', '{}', 'delivered', 1, 200, now()),
            ($1, $3, 'task.created', '{}', 'delivered', 1, 200, now())`,
    [t.tenantId, id, otherHook],
  );

  const res = await fetch(`${server.url}/webhooks/${id}/deliveries`, {
    headers: { authorization: `Bearer ${t.rawKey}` },
  });
  assert.equal(res.status, 200);
  const rows = (await res.json()) as Array<{ status: string; attempts: number; responseStatus: number; eventType: string }>;
  assert.equal(rows.length, 2, 'only this webhook');
  assert.deepEqual(
    rows.map((r) => [r.status, r.attempts, r.responseStatus, r.eventType]),
    [
      ['delivered', 1, 200, 'task.created'],
      ['failed', 3, 500, 'task.created'],
    ],
  );

  const opKey = await seedKey(t.tenantId, 'operator');
  const forbidden = await fetch(`${server.url}/webhooks/${id}/deliveries`, {
    headers: { authorization: `Bearer ${opKey}` },
  });
  assert.equal(forbidden.status, 403);
});
