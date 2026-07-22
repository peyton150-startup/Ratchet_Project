import type { PoolClient } from 'pg';
import { loadRulesForEvent } from './store';
import type { Rule } from './types';

/**
 * Short-TTL cache of the active rules per (tenant, eventType). Rules change rarely; events are the
 * hot path, so re-querying and re-validating every rule on every event is wasted work.
 *
 * Staleness semantics (deliberate):
 * - `invalidate(tenantId)` is the primary mechanism — call it whenever rules are written.
 * - The TTL is the cross-process backstop: an API server that writes a rule cannot invalidate the
 *   worker's in-memory cache, so the TTL bounds how long a deactivated rule can keep firing.
 *   Keep it short for that reason.
 * - Dry-run must bypass the cache entirely (it has to see the exact version being edited).
 */
export class RulesCache {
  private readonly entries = new Map<string, { rules: Rule[]; expiresAt: number }>();

  constructor(private readonly ttlMs: number = 5_000) {}

  private key(tenantId: string, eventType: string): string {
    return `${tenantId}::${eventType}`;
  }

  async getForEvent(
    client: PoolClient,
    tenantId: string,
    eventType: string,
    now: number = Date.now(),
  ): Promise<Rule[]> {
    const key = this.key(tenantId, eventType);
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.rules;

    const rules = await loadRulesForEvent(client, eventType);
    this.entries.set(key, { rules, expiresAt: now + this.ttlMs });
    return rules;
  }

  /** Drop every cached entry for a tenant. Call after any rule write. */
  invalidate(tenantId: string): void {
    const prefix = `${tenantId}::`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
