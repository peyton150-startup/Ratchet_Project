import Redis from 'ioredis';

export function createRedis(url: string | undefined): Redis {
  return new Redis(url ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
}

export type { Redis };
