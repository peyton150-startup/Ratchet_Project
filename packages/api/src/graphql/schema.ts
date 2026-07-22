import { GraphQLScalarType, GraphQLError, type GraphQLSchema } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { listTasks, getTask, listQueues } from '../tasks/read';
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

  type Query {
    tasks(queue: String, state: String, limit: Int): [Task!]!
    task(id: ID!): Task
    queues: [Queue!]!
  }

  type Mutation {
    claimTask(id: ID!): Task!
    completeTask(id: ID!): Task!
    blockTask(id: ID!): Task!
    assignTask(id: ID!): Task!
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
