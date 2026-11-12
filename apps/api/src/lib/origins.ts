/** Normalises an origin for comparison: lowercase, no trailing slash, no default port. */
export const normalizeOrigin = (o: string): string => {
  try {
    const u = new URL(o);
    return u.origin.toLowerCase();
  } catch {
    return o.trim().toLowerCase();
  }
};

export type OriginPolicy = { isAllowed: (origin: string) => boolean };

export const buildOriginPolicy = (allowed: readonly string[]): OriginPolicy => {
  const set = new Set(allowed.map(normalizeOrigin));
  return { isAllowed: (origin) => origin !== 'null' && set.has(normalizeOrigin(origin)) };
};

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF decision for a request that may carry an ambient session cookie.
 * - Safe methods: never blocked here (they must not change state).
 * - `Origin` present → must be on the allow-list (`null`, foreign, malformed → blocked).
 * - No `Origin` → the browser tells us via `Sec-Fetch-Site`; cross-site/same-site → blocked.
 * - Neither header → a non-browser client (curl, server-side fetch): no ambient cookie to abuse.
 */
export const csrfAllows = (
  method: string,
  headers: { origin?: string | undefined; secFetchSite?: string | undefined },
  policy: OriginPolicy,
): boolean => {
  if (SAFE.has(method.toUpperCase())) return true;
  if (headers.origin !== undefined) return policy.isAllowed(headers.origin);
  if (headers.secFetchSite !== undefined)
    return headers.secFetchSite === 'same-origin' || headers.secFetchSite === 'none';
  return true;
};
