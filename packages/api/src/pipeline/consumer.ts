import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db';
import type { Redis } from '../redis';
import { RulesEngine, type EngineEvent } from '../rules/engine';
import { TaskProcessor } from '../tasks/processor';
import {
  insertDeadLetter,
  createTaskFromDecision,
  cancelTasksForApplication,
} from '../tasks/service';
import { getTaskTx, type TaskView } from '../tasks/read';
import { assignTask, type RoutingService } from '../routing/assign';
import type { TaskPubSub } from '../pubsub';
import type { WebhookDispatcher } from '../webhooks/dispatcher';
import { metrics } from '../observability';

export interface ConsumeDeps {
  redis: Redis;
  appPool: Pool;
  engine: RulesEngine;
  processor: TaskProcessor;
  routing?: RoutingService; // when set, newly created tasks are auto-assigned
  pubsub?: TaskPubSub; // when set, created tasks are published for live updates
  webhooks?: WebhookDispatcher; // when set, task.created is dispatched to integrators
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

async function loadEventTx(client: PoolClient, eventId: string): Promise<EngineEvent | null> {
  const r = await client.query<{
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
}

/**
 * All database work for one message, in a SINGLE tenant transaction: load the event, evaluate
 * rules, create/cancel tasks, auto-assign. Returns the tasks created, for post-commit side effects.
 *
 * One transaction is both faster (one connection instead of ~5) and more correct: a crash
 * mid-message can no longer leave a task created but unassigned. Retry must wrap the whole
 * transaction — retrying inside it is impossible, since a failed statement aborts the transaction.
 */
async function processMessageTx(deps: ConsumeDeps, msg: StreamMessage): Promise<TaskView[]> {
  return withTenant(deps.appPool, msg.tenantId, async (client) => {
    const event = await loadEventTx(client, msg.eventId);
    if (!event) throw new Error(`event not found: ${msg.eventId}`);

    const decisions = await deps.engine.evaluateEventWithClient(client, msg.tenantId, event);
    const created: TaskView[] = [];

    for (const decision of decisions) {
      if (decision.action.kind === 'cancel_tasks') {
        const applicationId =
          (decision.subject['applicationId'] as string | undefined) ??
          (decision.subject['entityId'] as string | undefined) ??
          '';
        await cancelTasksForApplication(client, applicationId);
        continue;
      }
      const result = await createTaskFromDecision(client, msg.tenantId, msg.eventId, decision);
      if (!result.created) continue; // duplicate: an earlier delivery already handled it
      metrics.tasksCreated.inc({ queue: decision.action.queue });
      if (deps.routing) await assignTask(client, result.taskId);
      if (deps.pubsub || deps.webhooks) {
        const task = await getTaskTx(client, result.taskId);
        if (task) created.push(task);
      }
    }
    return created;
  });
}

/**
 * Handle one stream entry: run its transaction, emit post-commit side effects, then ACK. Missing
 * events / failures are dead-lettered and acked so nothing loops forever.
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
    const created = await processMessageTx(deps, msg);
    // Side effects run only after the transaction commits, so nothing is published for rolled-back work.
    for (const task of created) {
      if (deps.pubsub) await deps.pubsub.publish(msg.tenantId, task);
      if (deps.webhooks) {
        await deps.webhooks.dispatch(msg.tenantId, 'task.created', task).catch(() => {});
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
