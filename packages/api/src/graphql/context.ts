import type { Pool } from 'pg';
import { GraphQLError } from 'graphql';
import { can, isRole, type Permission } from '../authz';
import type { TaskPubSub } from '../pubsub';
import type { RulesEngine } from '../rules/engine';

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
