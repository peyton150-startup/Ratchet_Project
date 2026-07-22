import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';

// Augment Express Request with the resolved tenant for downstream handlers.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string;
      role?: string;
    }
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export interface AuthResult {
  tenantId: string;
  role: string | undefined;
}

/** Resolve tenant + role from a raw bearer key (SECURITY DEFINER lookup). Null if unknown. */
export async function authenticateKey(pool: Pool, rawKey: string): Promise<AuthResult | null> {
  const result = await pool.query<{ tenant_id: string | null; role: string | null }>(
    'SELECT tenant_id, role FROM ratchet_authenticate($1)',
    [hashApiKey(rawKey)],
  );
  const row = result.rows[0];
  if (!row || !row.tenant_id) return null;
  return { tenantId: row.tenant_id, role: row.role ?? undefined };
}

/**
 * Bearer-token auth. Resolves the tenant from the API key hash via the SECURITY DEFINER
 * function ratchet_authenticate (which bypasses RLS deliberately — ADR-005 rule 5), then
 * attaches tenantId to the request. No tenant context is needed for the lookup itself.
 */
export function authMiddleware(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !match[1]) {
      res.status(401).json({ error: 'missing or malformed Authorization header' });
      return;
    }
    try {
      const auth = await authenticateKey(pool, match[1].trim());
      if (!auth) {
        res.status(401).json({ error: 'invalid API key' });
        return;
      }
      req.tenantId = auth.tenantId;
      req.role = auth.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
