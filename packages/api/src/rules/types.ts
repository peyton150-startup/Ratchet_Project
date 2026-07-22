import { z } from 'zod';
import { EVENT_TYPES } from '../events/eventTypes';

// ---- Condition tree (ADR-004) ---------------------------------------------------------------
// Namespaced refs: "event.*", "payload.*", "delta.*", "state.*". Comparisons are [ref, literal].
// changed(field) is first-class for R10; { state: name } evaluates an allowlisted predicate (R7).

const literal = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown())]);
const comparison = z.tuple([z.string(), literal]);

export type Condition =
  | { and: Condition[] }
  | { or: Condition[] }
  | { not: Condition }
  | { changed: string }
  | { state: string }
  | { eq: [string, unknown] }
  | { neq: [string, unknown] }
  | { gt: [string, unknown] }
  | { lt: [string, unknown] }
  | { gte: [string, unknown] }
  | { lte: [string, unknown] }
  | { in: [string, unknown] };

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
      sla: z.string().regex(/^\d+[smhd]$/, 'SLA must be a number followed by s, m, h, or d'),
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
