import { z } from 'zod';
import { EVENT_TYPES, SLA_PATTERN, SLA_HINT, QUEUE_STRATEGIES, type Condition } from '@workspace/sdk';

// ---- Condition tree (ADR-004) ---------------------------------------------------------------
// The Condition shape, event catalog, SLA format and queue strategies come from the shared domain
// module (packages/sdk/src/domain.ts). This file adds only the runtime validation the server needs,
// so the schema and the type can never describe different things.
export type { Condition };

const literal = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown())]);
const comparison = z.tuple([z.string(), literal]);

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(conditionSchema) }).strict(),
    z.object({ or: z.array(conditionSchema) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ changed: z.string() }).strict(),
    z.object({ state: z.string() }).strict(),
    z.object({ eq: comparison }).strict(),
    z.object({ neq: comparison }).strict(),
    z.object({ gt: comparison }).strict(),
    z.object({ lt: comparison }).strict(),
    z.object({ gte: comparison }).strict(),
    z.object({ lte: comparison }).strict(),
    z.object({ in: comparison }).strict(),
  ]),
);

// ---- Trigger union (ADR-004: sweeps are a rule type) ----------------------------------------
export const triggerSchema = z.union([
  z.object({ type: z.literal('event'), event: z.enum(EVENT_TYPES) }).strict(),
  z.object({ type: z.literal('schedule'), cron: z.string(), scan: z.string() }).strict(),
]);
export type Trigger = z.infer<typeof triggerSchema>;

// ---- Action union (create_task for R1-R11, cancel_tasks for R12) -----------------------------
export const actionSchema = z.union([
  z
    .object({
      kind: z.literal('create_task'),
      queue: z.string(),
      // SLA duration like 4h / 30m / 2d / 90s — validated so a bad rule fails fast, not at runtime.
      sla: z.string().regex(SLA_PATTERN, SLA_HINT),
      priority: z.number().int().optional(),
      template: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cancel_tasks'),
      scope: z.string(),
    })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;

// ---- Rule -----------------------------------------------------------------------------------
export const ruleSchema = z
  .object({
    ruleKey: z.string().min(1),
    version: z.number().int().positive(),
    trigger: triggerSchema,
    condition: conditionSchema.nullable(),
    action: actionSchema,
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;
