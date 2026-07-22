import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { RatchetClient, RatchetError, verifyWebhookSignature } from '../src/index';

// A fake fetch that records calls and returns queued responses.
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
function fakeFetch(response: { ok?: boolean; status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: (init?.method as string) ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body as string | undefined,
    });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json,
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function client(fetchImpl: typeof fetch): RatchetClient {
  return new RatchetClient({ baseUrl: 'https://api.test/', apiKey: 'k-123', fetch: fetchImpl });
}

test('verifyWebhookSignature accepts a valid signature and rejects tampering/staleness', () => {
  const now = 1_700_000_000_000;
  const t = Math.floor(now / 1000);
  const body = '{"type":"task.created","data":{"id":"1"}}';
  const v1 = createHmac('sha256', 'secret').update(`${t}.${body}`).digest('hex');
  const header = `t=${t},v1=${v1}`;

  assert.equal(verifyWebhookSignature('secret', body, header, { nowMs: now }), true);
  assert.equal(verifyWebhookSignature('secret', body + 'x', header, { nowMs: now }), false);
  assert.equal(verifyWebhookSignature('nope', body, header, { nowMs: now }), false);
  assert.equal(verifyWebhookSignature('secret', body, header, { nowMs: now + 600_000 }), false);
});

test('ingest posts to /events with the bearer key', async () => {
  const { fn, calls } = fakeFetch({ status: 201, json: { eventId: 'e-1', duplicate: false } });
  const res = await client(fn).ingest({ idempotencyKey: 'i-1', type: 'application.submitted', entityId: 'a-1' });
  assert.deepEqual(res, { eventId: 'e-1', duplicate: false });
  assert.equal(calls[0]!.url, 'https://api.test/events');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers['authorization'], 'Bearer k-123');
});

test('tasks() runs a GraphQL query and returns the list', async () => {
  const task = { id: 't-1', state: 'open', queue: 'intake' };
  const { fn, calls } = fakeFetch({ json: { data: { tasks: [task] } } });
  const tasks = await client(fn).tasks({ queue: 'intake' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.id, 't-1');
  assert.equal(calls[0]!.url, 'https://api.test/graphql');
  assert.ok((calls[0]!.body as string).includes('tasks('));
});

test('claimTask runs the mutation and returns the task', async () => {
  const { fn, calls } = fakeFetch({ json: { data: { claimTask: { id: 't-1', state: 'claimed' } } } });
  const t = await client(fn).claimTask('t-1');
  assert.equal(t.state, 'claimed');
  assert.ok((calls[0]!.body as string).includes('claimTask'));
});

test('GraphQL errors surface as RatchetError', async () => {
  const { fn } = fakeFetch({ json: { errors: [{ message: 'forbidden' }] } });
  await assert.rejects(client(fn).tasks(), (e) => e instanceof RatchetError && /forbidden/.test(e.message));
});

test('registerWebhook returns the id and secret', async () => {
  const { fn, calls } = fakeFetch({ status: 201, json: { id: 'w-1', secret: 's-1', url: 'u', events: ['task.created'] } });
  const wh = await client(fn).registerWebhook({ url: 'https://x.test/hook', events: ['task.created'] });
  assert.equal(wh.id, 'w-1');
  assert.equal(wh.secret, 's-1');
  assert.equal(calls[0]!.url, 'https://api.test/webhooks');
  assert.equal(calls[0]!.method, 'POST');
});
