import express from 'express';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { createHandler } from 'graphql-http/lib/use/express';
import { authMiddleware } from './auth';
import { requirePermission } from './authz';
import { eventsRouter } from './events/route';
import { webhooksRouter } from './webhooks/route';
import { schema } from './graphql/schema';
import { renderMetrics } from './observability';
import { errorHandler, rateLimit, requestObserver } from './middleware';
import type { TaskPubSub } from './pubsub';
import type { RulesEngine } from './rules/engine';
import type { Resolver } from './webhooks/urlGuard';

export interface AppOptions {
  pubsub?: TaskPubSub;
  engine?: RulesEngine;
  /** Requests per window per tenant on the ingest path. */
  ingestRateLimit?: { windowMs: number; max: number };
  /** DNS resolver for the webhook SSRF guard; injected by tests to avoid real lookups. */
  webhookResolver?: Resolver;
}

/** Build the Express app around a given pool. Kept separate from listen() so tests can drive it. */
export function buildApp(pool: Pool, pubsub?: TaskPubSub, engine?: RulesEngine, opts: AppOptions = {}): Express {
  const app = express();

  // Cap request bodies: an event envelope is small, and an unbounded body is a cheap DoS.
  app.use(express.json({ limit: process.env.MAX_BODY_SIZE ?? '256kb' }));
  app.use(requestObserver());

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

  // Prometheus scrape endpoint. Unauthenticated on purpose: it exposes no tenant data, and scrapers
  // typically cannot present an API key. Restrict at the network layer in production.
  app.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  // Event ingest: auth resolves tenant + role, RBAC requires events:ingest, then rate limit + router.
  const ingestLimit = opts.ingestRateLimit ?? {
    windowMs: Number(process.env.INGEST_RATE_WINDOW_MS ?? 1000),
    max: Number(process.env.INGEST_RATE_MAX ?? 2000),
  };
  app.use(
    '/events',
    authMiddleware(pool),
    requirePermission('events:ingest'),
    rateLimit(ingestLimit),
    eventsRouter(pool),
  );

  // Webhook management for integrators (REST), guarded by webhooks:manage.
  app.use('/webhooks', authMiddleware(pool), requirePermission('webhooks:manage'), webhooksRouter(pool, opts.webhookResolver));

  // GraphQL console API (ADR-003): auth resolves tenant + role into the GraphQL context; per-field
  // RBAC is enforced in the resolvers.
  app.use(
    '/graphql',
    authMiddleware(pool),
    createHandler({
      schema,
      context: (req) => {
        const raw = req.raw as { tenantId?: string; role?: string };
        return { pool, tenantId: raw.tenantId, role: raw.role, pubsub, engine };
      },
    }),
  );

  // Must be last: turns an unhandled route error into JSON instead of an HTML stack trace.
  app.use(errorHandler);

  return app;
}
