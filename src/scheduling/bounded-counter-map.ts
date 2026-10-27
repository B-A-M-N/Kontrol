/** Small time-windowed LRU counters for scheduler-local recurrence hints. */
export class BoundedCounterMap {
  private readonly values = new Map<string, { count: number; at: number }>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  }

  get size(): number { return this.values.size; }

  get(key: string, now: number, ttlMs: number): number | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (now - entry.at > ttlMs) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.count;
  }

  set(key: string, count: number, at: number): void {
    this.values.delete(key);
    this.values.set(key, { count, at });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}
