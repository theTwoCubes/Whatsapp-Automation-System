// Meta retries webhooks it thinks were not acknowledged, so the same message
// or status can arrive more than once. We keep the ids we have handled and
// skip repeats. In memory and single instance for now, a database backed
// version comes later.
export class SeenStore {
  constructor(ttlMs = 10 * 60 * 1000, maxEntries = 5000) {
    this.seen = new Map();
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  // Records the id and returns true the first time we see it, false on a repeat.
  markIfNew(id) {
    this.prune();
    if (this.seen.has(id)) {
      return false;
    }
    this.seen.set(id, Date.now());
    return true;
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(id);
      }
    }
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
