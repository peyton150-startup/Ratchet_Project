import { Router } from 'express';
import type { Pool } from 'pg';
import { eventInputSchema } from './schema';
import { ingestEvent, IdempotencyConflictError } from './ingest';
import { metrics } from '../observability';

export function eventsRouter(pool: Pool): Router {
  const router = Router();

  router.post('/', async (req, res, next) => {
    const parsed = eventInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid event', details: parsed.error.flatten() });
      return;
    }
    // authMiddleware guarantees tenantId is set before this handler runs.
    const tenantId = req.tenantId as string;
    try {
      const result = await ingestEvent(pool, tenantId, parsed.data);
      metrics.eventsIngested.inc({ duplicate: String(result.duplicate) });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({ error: 'idempotency key reused with a different payload' });
        return;
      }
      next(err);
    }
  });

  return router;
}
