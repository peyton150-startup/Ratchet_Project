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
import { log } from './observability';

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
  log.info('server started', { port: PORT, endpoints: ['/graphql', '/events', '/webhooks', '/metrics'] });
});

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish, then close the
 * pool and Redis. Without this, a rolling deploy cuts live requests and leaks connections.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server shutting down', { signal });

  // Force-exit if a hung connection prevents a clean close.
  const forceExit = setTimeout(() => {
    log.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    wsServer.clients.forEach((client) => client.close(1001, 'server shutting down'));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await pool.end();
    log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error('error during shutdown', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
