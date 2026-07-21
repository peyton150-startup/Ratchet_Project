// The 11 events from docs/demo-domain.md, mapped to the entity each one concerns.
// This encodes demo-domain knowledge in one place so the ingest path can derive entity_type.
export const EVENT_ENTITY = {
  'application.submitted': 'LoanApplication',
  'application.updated': 'LoanApplication',
  'application.withdrawn': 'LoanApplication',
  'document.uploaded': 'Document',
  'document.rejected': 'Document',
  'verification.completed': 'VerificationResult',
  'underwriting.decision_recorded': 'UnderwritingDecision',
  'condition.created': 'Condition',
  'condition.cleared': 'Condition',
  'borrower.updated': 'Borrower',
  'closing.scheduled': 'LoanApplication',
} as const;

export type EventType = keyof typeof EVENT_ENTITY;

export const EVENT_TYPES = Object.keys(EVENT_ENTITY) as [EventType, ...EventType[]];

export function entityTypeFor(type: EventType): string {
  return EVENT_ENTITY[type];
}
