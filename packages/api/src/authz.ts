import type { Request, Response, NextFunction } from 'express';

// RBAC (Phase 3): roles within a tenant, above the RLS tenant boundary.
export type Role = 'operator' | 'admin' | 'integrator';

export type Permission =
  | 'events:ingest' // post events to the ingest API
  | 'tasks:read' // view tasks/queues
  | 'tasks:work' // claim/complete/block/assign tasks
  | 'rules:read' // view rules
  | 'rules:write' // create/version/edit rules, dry-run
  | 'queues:manage'; // manage agents, queues, membership

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  integrator: ['events:ingest'],
  operator: ['tasks:read', 'tasks:work', 'rules:read'],
  admin: ['events:ingest', 'tasks:read', 'tasks:work', 'rules:read', 'rules:write', 'queues:manage'],
};

export function isRole(value: unknown): value is Role {
  return value === 'operator' || value === 'admin' || value === 'integrator';
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Express guard: require `permission` for the authenticated key's role (set by authMiddleware). */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.role;
    if (!role || !isRole(role) || !can(role, permission)) {
      res.status(403).json({ error: 'forbidden', required: permission });
      return;
    }
    next();
  };
}
