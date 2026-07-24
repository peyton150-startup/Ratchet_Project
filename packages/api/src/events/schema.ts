import { z } from 'zod';
import { EVENT_TYPES } from './eventTypes';

// Ingest envelope for POST /events. `.strict()` rejects unknown keys so malformed
// payloads fail validation rather than being silently accepted.
export const eventInputSchema = z
  .object({
    idempotencyKey: z.string().min(1),
    type: z.enum(EVENT_TYPES),
    entityId: z.string().min(1),
    occurredAt: z.string().datetime().optional(),
    // Producer-set payload schema version (defaults to 1). Stored with every event so payload shapes
    // can evolve while old and new code coexist (DDIA Ch.4: version each record; rules/consumers can
    // dispatch on it rather than guessing a shape). Bump it when the payload/delta contract changes.
    schemaVersion: z.number().int().positive().optional(),
    delta: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

export type EventInput = z.infer<typeof eventInputSchema>;
