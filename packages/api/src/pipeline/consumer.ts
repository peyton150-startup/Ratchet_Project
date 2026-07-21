import type { Pool } from 'pg';
import { withTenant } from '../db';
import type { Redis } from '../redis';
import { RulesEngine, type EngineEvent } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';
import { insertDeadLetter } from '../tasks/service';

export interface ConsumeDeps {
  redis: Redis;
  appPool: Pool;
  engine: RulesEngine;
  processor: TaskProcessor;
}

export interface ConsumeOptions {
  streamKey: string;
  group: string;
  consumer: string;
  count?: number;
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

async function loadEvent(
  pool: Pool,
  tenantId: string,
  eventId: string,
): Promise<EngineEvent | null> {
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
 * The pipeline consumer: read events off the stream, run the rules engine, and turn each decision
 * into a task via the processor (which is exactly-once and DLQs poison task creation). A message
 * whose event is missing or whose processing throws is dead-lettered and acked, so it is not retried
 * forever. Returns the number of messages processed.
 */
export async function consumeBatch(deps: ConsumeDeps, opts: ConsumeOptions): Promise<number> {
  const { redis, appPool, engine, processor } = deps;
  const res = (await redis.xreadgroup(
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

  let processed = 0;
  for (const [id, fields] of entries) {
    const rec = fieldsToRecord(fields);
    const msg: StreamMessage = { tenantId: rec['tenantId'] ?? '', eventId: rec['eventId'] ?? '' };
    try {
      const event = await loadEvent(appPool, msg.tenantId, msg.eventId);
      if (!event) throw new Error(`event not found: ${msg.eventId}`);
      const decisions = await engine.evaluateEvent(msg.tenantId, event);
      for (const decision of decisions) {
        await processor.processDecision(msg.tenantId, msg.eventId, decision);
      }
    } catch (err) {
      await withTenant(appPool, msg.tenantId, (c) =>
        insertDeadLetter(c, msg.tenantId, {
          source: 'pipeline',
          reference: msg.eventId,
          payload: msg,
          error: err instanceof Error ? err.message : String(err),
          attempts: 1,
        }),
      ).catch(() => {
        /* if the tenant is unknown we cannot DLQ under RLS; ack anyway to avoid a poison loop */
      });
    }
    await redis.xack(opts.streamKey, opts.group, id);
    processed += 1;
  }
  return processed;
}
