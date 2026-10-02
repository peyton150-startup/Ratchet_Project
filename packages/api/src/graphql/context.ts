import type { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { can, isRole, permissionsFor, type Permission } from '../authz.js';
import type { TaskPubSub } from '../pubsub.js';
import type { RulesEngine } from '../rules/engine.js';

export interface GraphQLContext {
  pool: Pool;
  tenantId?: string;
  role?: string;
  pubsub?: TaskPubSub;
  // Shared engine instance: rule writes must invalidate its cache, and dry-run reuses it.
  engine?: RulesEngine;
}

/** Require an authenticated tenant + a role holding `permission`, else throw a GraphQL error. */
export function requirePermission(ctx: GraphQLContext, permission: Permission): string {
  if (!ctx.tenantId) {
    throw new GraphQLError('unauthenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  if (!isRole(ctx.role) || !can(ctx.role, permission)) {
    throw new GraphQLError('forbidden', { extensions: { code: 'FORBIDDEN', required: permission } });
  }
  return ctx.tenantId;
}

/** Who the caller is. Needs a valid key and nothing more, so every role can ask. */
export function describeViewer(ctx: GraphQLContext): { role: string; permissions: readonly Permission[] } {
  if (!ctx.tenantId) {
    throw new GraphQLError('unauthenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return { role: ctx.role ?? 'unknown', permissions: isRole(ctx.role) ? permissionsFor(ctx.role) : [] };
}
