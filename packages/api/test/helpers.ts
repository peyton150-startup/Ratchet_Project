import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createPool } from '../src/db';
import { hashApiKey } from '../src/auth';
import { entityTypeFor, type EventType } from '../src/events/eventTypes';
import type { Rule } from '../src/rules/types';

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
  // Default key is admin so existing tests can exercise any RBAC-gated route.
  const rawKey = await seedKey(tenantId, 'admin');
  return { tenantId, rawKey };
}

/** Create an API key with a specific role and return the raw key. */
export async function seedKey(tenantId: string, role: 'operator' | 'admin' | 'integrator'): Promise<string> {
  const rawKey = randomUUID();
  await adminPool.query('INSERT INTO api_keys (tenant_id, key_hash, role) VALUES ($1, $2, $3)', [
    tenantId,
    hashApiKey(rawKey),
    role,
  ]);
  return rawKey;
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

// --- Phase 2b seeding/inspection (admin pool bypasses RLS) ---

export interface SeedEventInput {
  type: EventType;
  entityId: string;
  payload?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  occurredAt?: string;
}

export async function seedEvent(tenantId: string, e: SeedEventInput): Promise<void> {
  await adminPool.query(
    `INSERT INTO events (id, tenant_id, event_type, entity_type, entity_id, occurred_at, delta, payload)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantId,
      e.type,
      entityTypeFor(e.type),
      e.entityId,
      e.occurredAt ?? new Date().toISOString(),
      JSON.stringify(e.delta ?? {}),
      JSON.stringify(e.payload ?? {}),
    ],
  );
}

export async function seedRule(tenantId: string, rule: Rule): Promise<void> {
  await adminPool.query(
    `INSERT INTO rules (tenant_id, rule_key, version, trigger, condition, action, active)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [
      tenantId,
      rule.ruleKey,
      rule.version,
      JSON.stringify(rule.trigger),
      rule.condition === null ? null : JSON.stringify(rule.condition),
      JSON.stringify(rule.action),
    ],
  );
}

export interface AuditRow {
  rule_key: string;
  rule_version: number;
  trigger_type: string;
  matched: boolean;
  dry_run: boolean;
}

export async function auditFor(tenantId: string): Promise<AuditRow[]> {
  const res = await adminPool.query<AuditRow>(
    `SELECT rule_key, rule_version, trigger_type, matched, dry_run
       FROM rule_audit WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return res.rows;
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
