import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { DATABASE_URL, PORT } from './config.js';
import { createPool } from './db.js';
import { createRedis } from './redis.js';
import { buildApp } from './app.js';
import { authenticateKey } from './auth.js';
import { TaskPubSub } from './pubsub.js';
import { schema } from './graphql/schema.js';
import { RulesEngine } from './rules/engine.js';
import { log } from './observability.js';
import { allowedOrigins } from './middleware.js';

const pool = createPool(DATABASE_URL);
const pubsub = new TaskPubSub(createRedis(process.env.REDIS_URL), process.env.REDIS_URL);
// One engine instance shared by HTTP and WS so a rule write invalidates the cache both see.
const engine = new RulesEngine(pool);
const app = buildApp(pool, pubsub, engine);
const httpServer = createServer(app);

// GraphQL subscriptions over WebSocket (ADR-003). Auth via connectionParams.authorization; the
// resolved tenant + role + pubsub become the subscription context.
// CORS does not apply to WebSockets, so the same allowlist is enforced at the handshake instead —
// otherwise the subscription endpoint would be the one cross-origin hole left open.
const wsOrigins = allowedOrigins();
const wsServer = new WebSocketServer({
  server: httpServer,
  path: '/graphql',
  verifyClient: ({ origin }: { origin: string }) =>
    // No Origin header means a non-browser client (SDK, CLI), which CORS was never protecting.
    !origin || wsOrigins.size === 0 || wsOrigins.has(origin.replace(/\/$/, '')),
});
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
  // graphql-ws ships one CommonJS-flavoured .d.ts for both the require and import
  // conditions, so its internal reference to @types/ws resolves under a different
  // module mode than ours. The two WebSocketServer types are structurally identical
  // and this is the same object at runtime; only their nominal identities differ.
  wsServer as unknown as Parameters<typeof useServer>[1],
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
