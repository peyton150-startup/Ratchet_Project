// Which console views a key can use. Kept pure so the mapping from permissions to tabs is testable
// without rendering the app shell.

export const VIEWS = [
  { id: 'operator', label: 'Operator', needs: 'tasks:read' },
  // Reading rules is not enough to be useful here: the view is for authoring and publishing them.
  { id: 'admin', label: 'Admin', needs: 'rules:write' },
  { id: 'events', label: 'Send event', needs: 'events:ingest' },
  { id: 'webhooks', label: 'Webhooks', needs: 'webhooks:manage' },
] as const;

export type View = (typeof VIEWS)[number];
export type ViewId = View['id'];

/**
 * The views a key with these permissions can use. `null` means the API could not say (an API that
 * predates the viewer query, or a failed request): show everything and let each view report its own
 * refusal, rather than locking a valid key out of the console.
 */
export function visibleViews(permissions: readonly string[] | null): readonly View[] {
  if (permissions === null) return VIEWS;
  return VIEWS.filter((v) => permissions.includes(v.needs));
}
