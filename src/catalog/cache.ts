/**
 * Values with a time-to-live, oldest dropped beyond `maxEntries`. Holding promises makes concurrent
 * callers of the same key share one request.
 */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.value;
    }
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, value: V): void {
    const now = Date.now();
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
    if (this.entries.size > this.maxEntries) {
      for (const [k, entry] of this.entries) {
        if (entry.expires <= now || this.entries.size > this.maxEntries) {
          this.entries.delete(k);
        }
      }
    }
  }

  /** Removes `key` only while it still holds `value` (a newer entry is kept). */
  deleteIf(key: string, value: V): void {
    if (this.entries.get(key)?.value === value) {
      this.entries.delete(key);
    }
  }
}

/** The cached promise for `key`, or a new one from `load`; a rejected promise is evicted so the next call retries. */
export function memo<T>(cache: TtlCache<Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }
  const value = load();
  cache.set(key, value);
  value.catch(() => cache.deleteIf(key, value));
  return value;
}

/** Runs `work` over `items` with at most `limit` calls in flight; rejects on the first failure. */
export async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await work(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
