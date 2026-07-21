import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { authMiddleware } from './auth';
import { eventsRouter } from './events/route';

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

  // Event ingest (Phase 2a): auth resolves the tenant, then the router validates and appends.
  app.use('/events', authMiddleware(pool), eventsRouter(pool));

  return app;
}
