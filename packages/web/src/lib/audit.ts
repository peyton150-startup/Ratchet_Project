// Wording for the rule audit trail: what one evaluation did, and what set it off. Pure, so the
// operator's "why this task exists" and the admin's "recent decisions" say the same thing.

import type { AuditEntry } from './api';

/** What the rule did with the trigger it looked at. */
export function auditOutcome(entry: Pick<AuditEntry, 'matched' | 'decision'>): string {
  if (!entry.matched) return 'did not match';
  const action = ((entry.decision ?? {}) as { action?: { kind?: string; template?: string; queue?: string } }).action;
  if (action?.kind === 'cancel_tasks') return 'cancelled open tasks';
  if (action?.kind === 'create_task') return `created "${action.template}" in ${action.queue}`;
  return 'matched';
}

/** What woke the rule. An event that has aged out of retention leaves only its trigger type. */
export function auditTrigger(entry: Pick<AuditEntry, 'triggerType' | 'eventType' | 'entityId'>): string {
  if (entry.triggerType === 'schedule') return 'scheduled sweep';
  return entry.eventType ? `${entry.eventType} · ${entry.entityId}` : 'an event no longer retained';
}

/** How the queue's strategy picks an agent, in words. */
export function describeStrategy(strategy: string, requiredSkill: string | null): string {
  if (strategy === 'skill_tag') return `agents with the ${requiredSkill ?? '(unset)'} skill, in turn`;
  if (strategy === 'capacity') return 'the agent with the most free capacity';
  if (strategy === 'round_robin') return 'each agent in turn';
  return strategy;
}
