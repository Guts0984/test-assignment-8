/**
 * In-process fixed-window counter used as a CHEAP pre-filter in front of the PostgreSQL limiter:
 * once a key is over its quota the request is rejected without touching the database, so a flood
 * cannot turn the limiter itself into a database load. Bounded memory (maxEntries).
 */
export type Gate = {
  /** Registers a hit; returns the count in the current window. */
  hit: (key: string, now?: number) => number;
  size: () => number;
};

export const createGate = (windowMs: number, maxEntries = 50_000): Gate => {
  const map = new Map<string, { count: number; start: number }>();
  const sweep = (now: number) => {
    for (const [k, v] of map) if (now - v.start >= windowMs) map.delete(k);
    // still crowded (all entries live): drop the oldest insertions down to 90 %, so the next sweep
    // is far away (amortised O(1)) and an attacker minting keys cannot grow us past maxEntries
    const target = Math.floor(maxEntries * 0.9);
    for (const k of map.keys()) {
      if (map.size <= target) break;
      map.delete(k);
    }
  };
  return {
    hit: (key, now = Date.now()) => {
      const cur = map.get(key);
      if (cur && now - cur.start < windowMs) {
        cur.count += 1;
        return cur.count;
      }
      if (map.size >= maxEntries) sweep(now);
      map.set(key, { count: 1, start: now });
      return 1;
    },
    size: () => map.size,
  };
};
