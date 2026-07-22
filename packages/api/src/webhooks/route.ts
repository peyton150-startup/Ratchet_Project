import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTenant } from '../db';

const registerSchema = z
  .object({
    url: z.string().url(),
    events: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** REST management for integrator webhooks. Guarded by webhooks:manage upstream. */
export function webhooksRouter(pool: Pool): Router {
  const router = Router();

  // Register a webhook. The signing secret is returned once, here, and never again.
  router.post('/', async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid webhook', details: parsed.error.flatten() });
      return;
    }
    const tenantId = req.tenantId as string;
    const secret = randomBytes(24).toString('hex');
    try {
      const created = await withTenant(pool, tenantId, (c) =>
        c.query<{ id: string }>(
          `INSERT INTO webhooks (tenant_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, parsed.data.url, secret, parsed.data.events],
        ),
      );
      res.status(201).json({ id: created.rows[0]!.id, secret, ...parsed.data });
    } catch (err) {
      next(err);
    }
  });

  // List webhooks (secrets are never returned).
  router.get('/', async (req, res, next) => {
    const tenantId = req.tenantId as string;
    try {
      const rows = await withTenant(pool, tenantId, (c) =>
        c.query<{ id: string; url: string; events: string[]; active: boolean }>(
          `SELECT id, url, events, active FROM webhooks ORDER BY created_at DESC`,
        ),
      );
      res.json(rows.rows);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
