// A small fixed window rate limiter, in memory, no dependency. Used to slow down
// login attempts. Single instance is fine for now.
export function createRateLimiter({ max = 5, windowMs = 60000 } = {}) {
  const hits = new Map();

  return function check(key) {
    const now = Date.now();
    if (hits.size > 5000) prune(hits, now);

    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return { ok: true };
    }
    entry.count += 1;
    if (entry.count > max) {
      return { ok: false, retryAfter: Math.ceil((entry.reset - now) / 1000) };
    }
    return { ok: true };
  };
}

function prune(hits, now) {
  for (const [key, entry] of hits) {
    if (now > entry.reset) hits.delete(key);
  }
}
