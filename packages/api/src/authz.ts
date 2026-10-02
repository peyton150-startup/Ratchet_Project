import type { Request, Response, NextFunction } from 'express';

// RBAC (Phase 3): roles within a tenant, above the RLS tenant boundary.
export type Role = 'operator' | 'admin' | 'integrator';

export type Permission =
  | 'events:ingest' // post events to the ingest API
  | 'tasks:read' // view tasks/queues
  | 'tasks:work' // claim/complete/block/assign tasks
  | 'rules:read' // view rules
  | 'rules:write' // create/version/edit rules, dry-run
  | 'queues:manage' // manage agents, queues, membership
  | 'webhooks:manage' // register/list webhook endpoints
  | 'ops:read'; // view dead letters: system health, not an operator's or integrator's concern

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  integrator: ['events:ingest', 'webhooks:manage'],
  operator: ['tasks:read', 'tasks:work', 'rules:read'],
  admin: [
    'events:ingest',
    'tasks:read',
    'tasks:work',
    'rules:read',
    'rules:write',
    'queues:manage',
    'webhooks:manage',
    'ops:read',
  ],
};

export function isRole(value: unknown): value is Role {
  return value === 'operator' || value === 'admin' || value === 'integrator';
}

/** Everything a role may do. The console uses it to show only the views a key can use. */
export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
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
