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
    delta: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .strict();

export type EventInput = z.infer<typeof eventInputSchema>;
