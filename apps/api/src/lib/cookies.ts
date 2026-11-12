/**
 * Parses a Cookie header. A name that appears more than once is dropped entirely: a duplicate
 * usually means a sibling-subdomain "cookie tossing" attempt, and picking one would be a guess.
 */
export const parseCookies = (header: string | undefined): ReadonlyMap<string, string> => {
  const seen = new Map<string, string>();
  const dup = new Set<string>();
  if (!header || header.length > 8_192) return seen;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1);
    if (seen.has(name)) dup.add(name);
    seen.set(name, value);
  }
  for (const name of dup) seen.delete(name);
  return seen;
};

export const serializeSessionCookie = (
  name: string,
  token: string,
  opts: { maxAgeSeconds: number; secure: boolean },
): string =>
  [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');

export const clearSessionCookie = (name: string, secure: boolean): string =>
  serializeSessionCookie(name, '', { maxAgeSeconds: 0, secure });
