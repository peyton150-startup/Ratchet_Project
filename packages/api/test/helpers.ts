import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createPool } from '../src/db';
import { hashApiKey } from '../src/auth';

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_URL = process.env.DATABASE_URL;

// Admin pool (superuser) bypasses RLS — used to seed and inspect. App pool is the RLS-enforced role.
export const adminPool = createPool(ADMIN_URL);
export const appPool = createPool(APP_URL);

export async function resetDb(): Promise<void> {
  await adminPool.query(
    'TRUNCATE outbox, event_idempotency, events, api_keys, tenants RESTART IDENTITY CASCADE',
  );
}

export interface SeededTenant {
  tenantId: string;
  rawKey: string;
}

export async function seedTenant(name: string): Promise<SeededTenant> {
  const t = await adminPool.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  const tenantId = t.rows[0]!.id;
  const rawKey = randomUUID();
  await adminPool.query('INSERT INTO api_keys (tenant_id, key_hash) VALUES ($1, $2)', [
    tenantId,
    hashApiKey(rawKey),
  ]);
  return { tenantId, rawKey };
}

export async function countFor(tenantId: string): Promise<{ events: number; outbox: number }> {
  const e = await adminPool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM events WHERE tenant_id = $1',
    [tenantId],
  );
  const o = await adminPool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM outbox WHERE tenant_id = $1',
    [tenantId],
  );
  return { events: e.rows[0]!.c, outbox: o.rows[0]!.c };
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(app: Express): Promise<RunningServer> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface PostResult {
  status: number;
  json: { eventId?: string; duplicate?: boolean; error?: string };
}

export async function postEvent(base: string, key: string, body: unknown): Promise<PostResult> {
  const res = await fetch(`${base}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as PostResult['json'];
  return { status: res.status, json };
}
