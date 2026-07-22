import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { createHandler } from 'graphql-http/lib/use/express';
import { authMiddleware } from './auth';
import { requirePermission } from './authz';
import { eventsRouter } from './events/route';
import { schema } from './graphql/schema';

/** Build the Express app around a given pool. Kept separate from listen() so tests can drive it. */
export function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/db-check', async (_req, res) => {
    try {
      const result = await pool.query('SELECT 1');
      res.json({ status: 'ok', result: result.rows[0] });
    } catch (error) {
      res.status(500).json({ status: 'error', message: String(error) });
    }
  });

  // Event ingest: auth resolves tenant + role, RBAC requires events:ingest, then the router runs.
  app.use('/events', authMiddleware(pool), requirePermission('events:ingest'), eventsRouter(pool));

  // GraphQL console API (ADR-003): auth resolves tenant + role into the GraphQL context; per-field
  // RBAC is enforced in the resolvers. Subscriptions are a following slice.
  app.use(
    '/graphql',
    authMiddleware(pool),
    createHandler({
      schema,
      context: (req) => {
        const raw = req.raw as { tenantId?: string; role?: string };
        return { pool, tenantId: raw.tenantId, role: raw.role };
      },
    }),
  );

  return app;
}
