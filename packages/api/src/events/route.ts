import { Router } from 'express';
import type { Pool } from 'pg';
import { eventInputSchema } from './schema';
import { ingestEvent } from './ingest';

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
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
