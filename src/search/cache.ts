interface Entry<T> {
  value: T;
  expiresAt: number;
  stashed?: boolean;
}

/**
 * Tiny TTL cache with in-flight de-duplication:
 * identical requests that overlap in time share one promise.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, Promise<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number) {}

  async get(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit) return hit;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const load = loader()
      .then((value) => {
        if (this.ttlMs > 0) {
          this.store.set(key, Promise.resolve(value));
          setTimeout(() => this.store.delete(key), this.ttlMs).unref?.();
        }
        this.inflight.delete(key);
        return value;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, load);
    return load;
  }

  get size(): number {
    return this.store.size;
  }
}
