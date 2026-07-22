import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { DATABASE_URL, PORT } from './config';
import { createPool } from './db';
import { createRedis } from './redis';
import { buildApp } from './app';
import { authenticateKey } from './auth';
import { TaskPubSub } from './pubsub';
import { schema } from './graphql/schema';
import { RulesEngine } from './rules/engine';

const pool = createPool(DATABASE_URL);
const pubsub = new TaskPubSub(createRedis(process.env.REDIS_URL), process.env.REDIS_URL);
// One engine instance shared by HTTP and WS so a rule write invalidates the cache both see.
const engine = new RulesEngine(pool);
const app = buildApp(pool, pubsub, engine);
const httpServer = createServer(app);

// GraphQL subscriptions over WebSocket (ADR-003). Auth via connectionParams.authorization; the
// resolved tenant + role + pubsub become the subscription context.
const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
useServer(
  {
    schema,
    context: async (ctx) => {
      const header = (ctx.connectionParams?.authorization as string | undefined) ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      const auth = match && match[1] ? await authenticateKey(pool, match[1].trim()) : null;
      return { pool, tenantId: auth?.tenantId, role: auth?.role, pubsub, engine };
    },
  },
  wsServer,
);

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (GraphQL + WS subscriptions at /graphql)`);
});
