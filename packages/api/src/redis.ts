// Named rather than default: under NodeNext the default export resolves to a
// namespace, which cannot be used as a type by the consumers re-exporting it.
import { Redis } from 'ioredis';

export function createRedis(url: string | undefined): Redis {
  return new Redis(url ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
}

export type { Redis };
