import { BlockList, isIP } from 'node:net';

/** `::ffff:1.2.3.4` → `1.2.3.4`; strips zone ids and brackets. Returns null for non-IPs. */
export const normalizeIp = (raw: string | undefined | null): string | null => {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  return isIP(ip) ? ip.toLowerCase() : null;
};

/** Expands an IPv6 address to 8 hextets. */
const expandV6 = (ip: string): string[] => {
  const [head = '', tail] = ip.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<string>(Math.max(0, fill)).fill('0'), ...t].map((x) => x.padStart(4, '0'));
};

/**
 * The bucket an address is rate-limited under. IPv4: the address. IPv6: its /64 — one subscriber
 * normally owns a whole /64, so rotating addresses inside it must not mint fresh quotas.
 */
export const limiterKeyForIp = (ip: string): string =>
  isIP(ip) === 6 ? `${expandV6(ip).slice(0, 4).join(':')}::/64` : ip;

export type TrustedProxies = { readonly has: (ip: string) => boolean };

export const buildTrustedProxies = (entries: readonly string[]): TrustedProxies => {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr = '', bits] = entry.split('/');
    const ip = normalizeIp(addr);
    if (!ip) throw new Error(`TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR`);
    const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(ip, family);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 'ipv6' ? 128 : 32)) {
        throw new Error(`TRUSTED_PROXIES: "${entry}" has an invalid prefix length`);
      }
      list.addSubnet(ip, prefix, family);
    }
  }
  return {
    has: (ip) => {
      const n = normalizeIp(ip);
      return n !== null && list.check(n, isIP(n) === 6 ? 'ipv6' : 'ipv4');
    },
  };
};

/**
 * The real client address.
 * - Peer not a trusted proxy → the peer itself; X-Forwarded-For is ignored (it is attacker-controlled).
 * - Peer trusted → walk X-Forwarded-For from the RIGHT, skipping trusted proxies; the first untrusted
 *   hop is the client. Entries a client prepended (spoofing) are to the left of what our proxy appended.
 */
export const resolveClientIp = (
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
  trusted: TrustedProxies,
): string => {
  const peerIp = normalizeIp(peer) ?? '0.0.0.0';
  if (!trusted.has(peerIp)) return peerIp;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = normalizeIp(hops[i]);
    if (hop === null) return peerIp; // garbage in the chain: do not guess, fall back to the proxy itself
    if (!trusted.has(hop)) return hop;
  }
  return peerIp;
};
