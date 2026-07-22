import { GraphQLScalarType, GraphQLError, type GraphQLSchema } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { listTasks, getTask, listQueues } from '../tasks/read';
import { listEventsForEntity } from '../events/read';
import { listRuleVersions, createRuleVersion } from '../rules/read';
import { ruleSchema } from '../rules/types';
import { RulesEngine } from '../rules/engine';
import { TaskService } from '../tasks/service';
import { IllegalTransitionError, type TaskAction } from '../tasks/stateMachine';
import { RoutingService } from '../routing/assign';
import { requirePermission, type GraphQLContext } from './context';

const typeDefs = /* GraphQL */ `
  scalar DateTime
  scalar JSON

  type Task {
    id: ID!
    ruleKey: String!
    ruleVersion: Int!
    queue: String!
    template: String!
    priority: Int!
    state: String!
    assignee: ID
    slaDueAt: DateTime
    subject: JSON!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Queue {
    name: String!
    strategy: String!
    requiredSkill: String
    active: Boolean!
  }

  type Event {
    id: ID!
    type: String!
    entityType: String!
    entityId: String!
    occurredAt: DateTime!
    delta: JSON!
    payload: JSON!
  }

  type RuleVersion {
    ruleKey: String!
    version: Int!
    trigger: JSON!
    condition: JSON
    action: JSON!
    active: Boolean!
    createdAt: DateTime!
  }

  type DryRunResult {
    matched: Boolean!
    decision: JSON
  }

  input RuleVersionInput {
    ruleKey: String!
    trigger: JSON!
    condition: JSON
    action: JSON!
    active: Boolean
  }

  type Query {
    tasks(queue: String, state: String, limit: Int): [Task!]!
    task(id: ID!): Task
    queues: [Queue!]!
    "Event history for one entity, newest first — powers the console task-detail view."
    events(entityId: String!, limit: Int): [Event!]!
    "All stored rule versions (including superseded ones) for the admin console's history + diffs."
    rules(ruleKey: String): [RuleVersion!]!
  }

  type Mutation {
    claimTask(id: ID!): Task!
    completeTask(id: ID!): Task!
    blockTask(id: ID!): Task!
    assignTask(id: ID!): Task!
    "Publish the next version of a rule (supersedes the previous active version)."
    createRuleVersion(input: RuleVersionInput!): RuleVersion!
    "Evaluate a draft rule against a sample event without persisting anything."
    dryRunRule(rule: JSON!, event: JSON!): DryRunResult!
  }

  type Subscription {
    "Live task changes for the tenant, optionally filtered to one queue."
    queueUpdated(queue: String): Task!
  }
`;

const dateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value) {
    if (value === null || value === undefined) return null;
    return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
  },
  parseValue: (value) => value,
});

const json = new GraphQLScalarType({
  name: 'JSON',
  serialize: (value) => value,
  parseValue: (value) => value,
});

async function transitionMutation(
  ctx: GraphQLContext,
  id: string,
  action: TaskAction,
): Promise<unknown> {
  const tenantId = requirePermission(ctx, 'tasks:work');
  const svc = new TaskService(ctx.pool);
  try {
    await svc.transition(tenantId, id, action);
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      throw new GraphQLError(err.message, { extensions: { code: 'ILLEGAL_TRANSITION' } });
    }
    throw err;
  }
  const task = await getTask(ctx.pool, tenantId, id);
  if (ctx.pubsub && task) await ctx.pubsub.publish(tenantId, task);
  return task;
}

const resolvers = {
  DateTime: dateTime,
  JSON: json,
  Query: {
    tasks: (_p: unknown, args: { queue?: string; state?: string; limit?: number }, ctx: GraphQLContext) => {
      const tenantId = requirePermission(ctx, 'tasks:read');
      return listTasks(ctx.pool, tenantId, { queue: args.queue, state: args.state, limit: args.limit });
    },
    task: (_p: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const tenantId = requirePermission(ctx, 'tasks:read');
      return getTask(ctx.pool, tenantId, args.id);
    },
    queues: (_p: unknown, _a: unknown, ctx: GraphQLContext) => {
      const tenantId = requirePermission(ctx, 'tasks:read');
      return listQueues(ctx.pool, tenantId);
    },
    events: (_p: unknown, args: { entityId: string; limit?: number }, ctx: GraphQLContext) => {
      const tenantId = requirePermission(ctx, 'tasks:read');
      return listEventsForEntity(ctx.pool, tenantId, args.entityId, args.limit ?? 50);
    },
    rules: (_p: unknown, args: { ruleKey?: string }, ctx: GraphQLContext) => {
      const tenantId = requirePermission(ctx, 'rules:read');
      return listRuleVersions(ctx.pool, tenantId, args.ruleKey);
    },
  },
  Mutation: {
    claimTask: (_p: unknown, args: { id: string }, ctx: GraphQLContext) => transitionMutation(ctx, args.id, 'claim'),
    completeTask: (_p: unknown, args: { id: string }, ctx: GraphQLContext) => transitionMutation(ctx, args.id, 'complete'),
    blockTask: (_p: unknown, args: { id: string }, ctx: GraphQLContext) => transitionMutation(ctx, args.id, 'block'),
    assignTask: async (_p: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const tenantId = requirePermission(ctx, 'tasks:work');
      const res = await new RoutingService(ctx.pool).assign(tenantId, args.id);
      if (!res.assigned) {
        throw new GraphQLError(`task not assigned: ${res.reason}`, {
          extensions: { code: 'NOT_ASSIGNED', reason: res.reason },
        });
      }
      const task = await getTask(ctx.pool, tenantId, args.id);
      if (ctx.pubsub && task) await ctx.pubsub.publish(tenantId, task);
      return task;
    },
    createRuleVersion: async (
      _p: unknown,
      args: { input: { ruleKey: string; trigger: unknown; condition: unknown; action: unknown; active?: boolean } },
      ctx: GraphQLContext,
    ) => {
      const tenantId = requirePermission(ctx, 'rules:write');
      // Validate the whole rule before storing: a malformed rule must fail here, not at task time.
      const parsed = ruleSchema.safeParse({
        ruleKey: args.input.ruleKey,
        version: 1, // placeholder — the real version is assigned inside createRuleVersion
        trigger: args.input.trigger,
        condition: args.input.condition ?? null,
        action: args.input.action,
      });
      if (!parsed.success) {
        throw new GraphQLError('invalid rule', {
          extensions: { code: 'INVALID_RULE', details: parsed.error.flatten() },
        });
      }
      const created = await createRuleVersion(ctx.pool, tenantId, {
        ruleKey: args.input.ruleKey,
        trigger: args.input.trigger,
        condition: args.input.condition ?? null,
        action: args.input.action,
        active: args.input.active,
      });
      // Rules changed: drop the engine's cached copies so the new version takes effect immediately
      // in this process (other processes fall back to the cache TTL).
      ctx.engine?.invalidate(tenantId);
      return created;
    },
    dryRunRule: async (
      _p: unknown,
      args: { rule: unknown; event: unknown },
      ctx: GraphQLContext,
    ) => {
      const tenantId = requirePermission(ctx, 'rules:write');
      const rule = ruleSchema.safeParse(args.rule);
      if (!rule.success) {
        throw new GraphQLError('invalid rule', {
          extensions: { code: 'INVALID_RULE', details: rule.error.flatten() },
        });
      }
      const engine = ctx.engine ?? new RulesEngine(ctx.pool);
      const sample = args.event as Record<string, unknown>;
      return engine.dryRunRule(tenantId, rule.data, {
        type: String(sample['type'] ?? ''),
        entityId: String(sample['entityId'] ?? ''),
        entityType: String(sample['entityType'] ?? ''),
        occurredAt: String(sample['occurredAt'] ?? new Date().toISOString()),
        payload: (sample['payload'] as Record<string, unknown>) ?? {},
        delta: (sample['delta'] as Record<string, unknown>) ?? {},
      });
    },
  },
  Subscription: {
    queueUpdated: {
      subscribe: (_p: unknown, args: { queue?: string }, ctx: GraphQLContext) => {
        const tenantId = requirePermission(ctx, 'tasks:read');
        if (!ctx.pubsub) {
          throw new GraphQLError('subscriptions unavailable', { extensions: { code: 'UNAVAILABLE' } });
        }
        return ctx.pubsub.subscribe(tenantId, args.queue ?? undefined);
      },
      resolve: (payload: unknown) => payload,
    },
  },
};

export const schema: GraphQLSchema = makeExecutableSchema({ typeDefs, resolvers });
