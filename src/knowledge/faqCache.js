// A tiny in-process cache for assembled FAQ context, keyed by the exact set of
// packs a reply uses. 100 leads on the same pack build the prompt once instead
// of once each. Kept in its own module so both the builder (context.js) and the
// write paths (faqs.js) can touch it without a circular import.
//
// Entries expire after a short TTL and every FAQ write clears the whole cache,
// so a stale answer can never outlive an edit by more than that TTL. Single
// process, single instance, same as the rest of the app.

const TTL_MS = 60_000;
const store = new Map();

export function cacheKey(packs) {
  return packs.map(String).sort().join('|');
}

export function getCached(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

export function setCached(key, value) {
  store.set(key, { value, at: Date.now() });
}

// Called on any FAQ write. Clearing everything is fine: the cache refills on
// the next reply and correctness beats a partial invalidation we could get
// subtly wrong.
export function bustFaqCache() {
  store.clear();
}
