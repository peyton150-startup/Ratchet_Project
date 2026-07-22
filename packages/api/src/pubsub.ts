import { createRedis, type Redis } from './redis';
import type { TaskView } from './tasks/read';

// Per-tenant channel; task changes fan out over Redis so publishes from any process (API mutations,
// pipeline worker) reach subscribers on the API server (ADR-003 multi-instance fan-out).
function channel(tenantId: string): string {
  return `ratchet:task:${tenantId}`;
}

/**
 * An async iterator over a tenant's task changes, optionally filtered to one queue. Each instance
 * opens its own Redis connection (subscriber mode) and closes it on return().
 */
export class TaskSubscription implements AsyncIterableIterator<TaskView> {
  private readonly sub: Redis;
  private readonly buffer: TaskView[] = [];
  private readonly waiters: Array<(r: IteratorResult<TaskView>) => void> = [];
  private closed = false;
  private readonly readyPromise: Promise<unknown>;

  constructor(makeSub: () => Redis, tenantId: string, private readonly filterQueue?: string) {
    this.sub = makeSub();
    this.sub.on('message', (_ch: string, message: string) => this.handle(message));
    this.readyPromise = this.sub.subscribe(channel(tenantId));
  }

  /** Resolves once the Redis subscription is active (publish before this may be missed). */
  ready(): Promise<unknown> {
    return this.readyPromise;
  }

  private handle(message: string): void {
    let task: TaskView;
    try {
      task = JSON.parse(message) as TaskView;
    } catch {
      return;
    }
    if (this.filterQueue && task.queue !== this.filterQueue) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: task, done: false });
    else this.buffer.push(task);
  }

  next(): Promise<IteratorResult<TaskView>> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve({ value: buffered, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async return(): Promise<IteratorResult<TaskView>> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
    this.sub.disconnect();
    return { value: undefined as never, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<TaskView> {
    return this;
  }
}

export class TaskPubSub {
  constructor(
    private readonly pub: Redis,
    private readonly redisUrl: string | undefined,
  ) {}

  publish(tenantId: string, task: TaskView): Promise<number> {
    return this.pub.publish(channel(tenantId), JSON.stringify(task));
  }

  subscribe(tenantId: string, filterQueue?: string): TaskSubscription {
    return new TaskSubscription(() => createRedis(this.redisUrl), tenantId, filterQueue);
  }
}
