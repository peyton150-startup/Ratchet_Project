// The event catalog lives in the shared domain module (packages/sdk/src/domain.ts) so the API,
// the rule builder and integrators all read the same list. Re-exported here to keep existing
// imports working and to mark this as the API's entry point to that vocabulary.
export { EVENT_ENTITY, EVENT_TYPES, entityTypeFor, type EventType } from '@workspace/sdk';
