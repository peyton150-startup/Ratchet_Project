import type { Pool } from 'pg';
import { withTenant } from '../db';
import type { Redis } from '../redis';
import { RulesEngine, type EngineEvent } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';
import { insertDeadLetter } from '../tasks/service';
import type { RoutingService } from '../routing/assign';

export interface ConsumeDeps {
  redis: Redis;
  appPool: Pool;
  engine: RulesEngine;
  processor: TaskProcessor;
  routing?: RoutingService; // optional: when set, newly created tasks are auto-assigned
}

export interface ConsumeOptions {
  streamKey: string;
  group: string;
  consumer: string;
  count?: number;
}

export interface ReclaimOptions extends ConsumeOptions {
  minIdleMs?: number; // only reclaim messages idle at least this long (default 60s)
}

interface StreamMessage {
  tenantId: string;
  eventId: string;
}

/** Create the consumer group (idempotent). MKSTREAM so the stream exists before any XADD. */
export async function ensureGroup(redis: Redis, streamKey: string, group: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
  } catch (err) {
    if (!String(err).includes('BUSYGROUP')) throw err;
  }
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    out[fields[i]!] = fields[i + 1]!;
  }
  return out;
}

async function loadEvent(pool: Pool, tenantId: string, eventId: string): Promise<EngineEvent | null> {
  return withTenant(pool, tenantId, async (c) => {
    const r = await c.query<{
      id: string;
      event_type: string;
      entity_type: string;
      entity_id: string;
      occurred_at: Date;
      delta: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, event_type, entity_type, entity_id, occurred_at, delta, payload
         FROM events WHERE id = $1`,
      [eventId],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0]!;
    return {
      eventId: row.id,
      type: row.event_type,
      entityId: row.entity_id,
      entityType: row.entity_type,
      occurredAt: new Date(row.occurred_at).toISOString(),
      payload: row.payload,
      delta: row.delta,
    };
  });
}

/**
 * Handle one stream entry: run the rules engine, turn each decision into a task (or a cancel) via
 * the processor, optionally auto-assign newly created tasks, then ACK. Missing events / failures are
 * dead-lettered and acked so nothing loops forever. Shared by live consumption and PEL reclaim.
 */
async function handleEntry(
  deps: ConsumeDeps,
  opts: ConsumeOptions,
  id: string,
  fields: string[] | null,
): Promise<void> {
  if (fields === null) {
    // Entry was deleted from the stream; just drop it from the PEL.
    await deps.redis.xack(opts.streamKey, opts.group, id);
    return;
  }
  const rec = fieldsToRecord(fields);
  const msg: StreamMessage = { tenantId: rec['tenantId'] ?? '', eventId: rec['eventId'] ?? '' };
  try {
    const event = await loadEvent(deps.appPool, msg.tenantId, msg.eventId);
    if (!event) throw new Error(`event not found: ${msg.eventId}`);
    const decisions = await deps.engine.evaluateEvent(msg.tenantId, event);
    for (const decision of decisions) {
      const outcome = await deps.processor.processDecision(msg.tenantId, msg.eventId, decision);
      if (
        deps.routing &&
        outcome.status === 'ok' &&
        outcome.result?.kind === 'created' &&
        outcome.result.task.created
      ) {
        // Best-effort: an unassignable task (no queue/agent) stays unassigned, not failed.
        await deps.routing.assign(msg.tenantId, outcome.result.task.taskId).catch(() => {});
      }
    }
  } catch (err) {
    await withTenant(deps.appPool, msg.tenantId, (c) =>
      insertDeadLetter(c, msg.tenantId, {
        source: 'pipeline',
        reference: msg.eventId,
        payload: msg,
        error: err instanceof Error ? err.message : String(err),
        attempts: 1,
      }),
    ).catch(() => {
      /* unknown tenant can't be DLQ'd under RLS; ack anyway to avoid a poison loop */
    });
  }
  await deps.redis.xack(opts.streamKey, opts.group, id);
}

/** Read and process new messages for this consumer. Returns the number processed. */
export async function consumeBatch(deps: ConsumeDeps, opts: ConsumeOptions): Promise<number> {
  const res = (await deps.redis.xreadgroup(
    'GROUP',
    opts.group,
    opts.consumer,
    'COUNT',
    opts.count ?? 10,
    'STREAMS',
    opts.streamKey,
    '>',
  )) as Array<[string, Array<[string, string[]]>]> | null;

  if (!res || res.length === 0) return 0;
  const entries = res[0]![1];
  for (const [id, fields] of entries) {
    await handleEntry(deps, opts, id, fields);
  }
  return entries.length;
}

/**
 * Reclaim and process messages left pending by a crashed consumer (Redis PEL). Uses XAUTOCLAIM to
 * take ownership of entries idle beyond minIdleMs, then runs them through the same handler. This is
 * what makes at-least-once hold across a consumer crash between read and ack.
 */
export async function reclaimPending(deps: ConsumeDeps, opts: ReclaimOptions): Promise<number> {
  const res = (await deps.redis.xautoclaim(
    opts.streamKey,
    opts.group,
    opts.consumer,
    opts.minIdleMs ?? 60_000,
    '0',
    'COUNT',
    opts.count ?? 10,
  )) as [string, Array<[string, string[] | null]>, string[]?];

  const entries = res[1] ?? [];
  for (const [id, fields] of entries) {
    await handleEntry(deps, opts, id, fields);
  }
  return entries.length;
}
