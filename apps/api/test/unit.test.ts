import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { parseEnv } from '../src/env';
import {
  buildTrustedProxies,
  limiterKeyForIp,
  normalizeIp,
  resolveClientIp,
} from '../src/lib/client-ip';
import { clearSessionCookie, parseCookies, serializeSessionCookie } from '../src/lib/cookies';
import { mapError } from '../src/lib/errors';
import { createGate } from '../src/lib/gate';
import { buildOriginPolicy, csrfAllows } from '../src/lib/origins';
import { Busy, createSemaphore } from '../src/lib/semaphore';
import { hashToken, isWellFormedToken, newToken } from '../src/lib/sessions';

const DB = 'postgres://u:supersecretpw@localhost:5432/db';

describe('env.ts', () => {
  it('applies defaults to every non-secret variable', () => {
    const e = parseEnv({ DATABASE_URL: DB });
    expect(e).toMatchObject({
      PORT: 3001,
      NODE_ENV: 'development',
      COOKIE_NAME: 'hd_session',
      AUTO_MIGRATE: true,
      AUTO_SEED: false,
      TRUSTED_PROXIES: [],
      COOKIE_SECURE: false,
    });
    expect(e.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });
  it('the secret has NO default and its absence fails fast', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });
  it('never echoes values (secrets) in the error message', () => {
    try {
      parseEnv({ DATABASE_URL: DB, PORT: 'supersecretpw' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('PORT');
      expect(String(e)).not.toContain('supersecretpw');
    }
  });
  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['PORT', '1.5'],
    ['LOGIN_PAIR_MAX_FAILURES', '0'],
    ['COOKIE_NAME', 'bad name;'],
    ['NODE_ENV', 'staging'],
    ['AUTO_SEED', 'yes'],
    ['LOG_LEVEL', 'verbose'],
  ])('rejects %s=%s', (k, v) => {
    expect(() => parseEnv({ DATABASE_URL: DB, [k]: v })).toThrow(new RegExp(k));
  });
  it('parses booleans, numbers, CSV; COOKIE_SECURE defaults on in production and can be overridden', () => {
    const e = parseEnv({
      DATABASE_URL: DB,
      PORT: '8080',
      AUTO_SEED: 'true',
      TRUSTED_PROXIES: '10.0.0.0/8, 127.0.0.1 ,',
      NODE_ENV: 'production',
    });
    expect(e).toMatchObject({ PORT: 8080, AUTO_SEED: true, COOKIE_SECURE: true });
    expect(e.TRUSTED_PROXIES).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(
      parseEnv({ DATABASE_URL: DB, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE,
    ).toBe(false);
  });
  it('treats empty strings (`FOO=` in .env) as unset, so defaults apply', () => {
    expect(parseEnv({ DATABASE_URL: DB, PORT: '', TRUSTED_PROXIES: '' }).PORT).toBe(3001);
  });
});

describe('client address resolution (X-Forwarded-For)', () => {
  const none = buildTrustedProxies([]);
  const proxy = buildTrustedProxies(['10.0.0.5', '192.168.0.0/16']);
  it('normalizes addresses; rejects junk', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    for (const bad of [
      '',
      'abc',
      '999.1.1.1',
      '1.2.3',
      undefined,
      null,
      '1.2.3.4; DROP',
      '1.2.3.4\r\nX: y',
    ])
      expect(normalizeIp(bad as string)).toBeNull();
  });
  it('an untrusted peer can NEVER choose its own address via the header', () => {
    expect(resolveClientIp('203.0.113.9', '1.1.1.1', none)).toBe('203.0.113.9');
    expect(resolveClientIp('203.0.113.9', '1.1.1.1, 10.0.0.5', proxy)).toBe('203.0.113.9');
    expect(resolveClientIp('::ffff:203.0.113.9', ['8.8.8.8'], proxy)).toBe('203.0.113.9');
  });
  it('a trusted proxy: rightmost untrusted hop wins; client-prepended spoofs are ignored', () => {
    expect(resolveClientIp('10.0.0.5', '198.51.100.7', proxy)).toBe('198.51.100.7');
    expect(resolveClientIp('10.0.0.5', '9.9.9.9, 198.51.100.7', proxy)).toBe('198.51.100.7');
    expect(resolveClientIp('10.0.0.5', '9.9.9.9, 198.51.100.7, 192.168.4.4', proxy)).toBe(
      '198.51.100.7',
    );
    expect(resolveClientIp('10.0.0.5', ['1.1.1.1', '198.51.100.7'], proxy)).toBe('198.51.100.7');
  });
  it('garbage or empty chains fall back to the proxy itself instead of guessing', () => {
    expect(resolveClientIp('10.0.0.5', 'unknown', proxy)).toBe('10.0.0.5');
    expect(resolveClientIp('10.0.0.5', '1.1.1.1, <script>', proxy)).toBe('10.0.0.5');
    expect(resolveClientIp('10.0.0.5', undefined, proxy)).toBe('10.0.0.5');
    expect(resolveClientIp('10.0.0.5', '192.168.1.1, 10.0.0.5', proxy)).toBe('10.0.0.5');
    expect(resolveClientIp(undefined, '1.1.1.1', none)).toBe('0.0.0.0');
  });
  it('with ONE trusted proxy (as in compose) clients on LAN / VPN / Docker-host private addresses stay distinct', () => {
    const nginx = buildTrustedProxies(['172.30.77.10']);
    const a = resolveClientIp('172.30.77.10', '192.168.1.10', nginx);
    const b = resolveClientIp('172.30.77.10', '192.168.1.20', nginx);
    expect(a).toBe('192.168.1.10');
    expect(b).toBe('192.168.1.20');
    expect(limiterKeyForIp(a)).not.toBe(limiterKeyForIp(b));
    expect(resolveClientIp('172.30.77.10', '172.19.0.1', nginx)).toBe('172.19.0.1'); // the Docker host gateway
    expect(resolveClientIp('172.30.77.10', '10.8.0.5', nginx)).toBe('10.8.0.5'); // a VPN client
    // the old compose setting trusted the whole private ranges: every such client collapsed into the proxy's address
    const broad = buildTrustedProxies(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);
    expect(resolveClientIp('172.30.77.10', '192.168.1.10', broad)).toBe('172.30.77.10');
  });
  it('validates TRUSTED_PROXIES entries', () => {
    expect(() => buildTrustedProxies(['nonsense'])).toThrow(/TRUSTED_PROXIES/);
    expect(() => buildTrustedProxies(['10.0.0.0/33'])).toThrow(/prefix/);
    expect(buildTrustedProxies(['10.1.0.0/16']).has('10.1.200.3')).toBe(true);
    expect(buildTrustedProxies(['10.1.0.0/16']).has('10.2.0.1')).toBe(false);
  });
  it('IPv6 clients are limited per /64, so rotating addresses inside it buys nothing', () => {
    const a = limiterKeyForIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(limiterKeyForIp('2001:db8:1:2::1')).toBe(a);
    expect(limiterKeyForIp('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe(a);
    expect(limiterKeyForIp('2001:db8:1:3::1')).not.toBe(a);
    expect(limiterKeyForIp('203.0.113.9')).toBe('203.0.113.9');
  });
});

describe('cookies', () => {
  it('parses normally, tolerates junk, drops names that appear twice (cookie tossing)', () => {
    expect(parseCookies('a=1; b=2').get('b')).toBe('2');
    expect(parseCookies('hd_session=good; hd_session=evil').has('hd_session')).toBe(false);
    expect(parseCookies('a=1; a=2; b=3').get('b')).toBe('3');
    expect(parseCookies('=x; ;;novalue; q="quoted"').get('q')).toBe('quoted');
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies(`a=${'x'.repeat(9000)}`).size).toBe(0);
  });
  it('session cookie is HttpOnly + SameSite=Lax; Secure only when asked; clearing sets Max-Age=0', () => {
    const c = serializeSessionCookie('hd', 'tok', { maxAgeSeconds: 60, secure: false });
    expect(c).toBe('hd=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60');
    expect(serializeSessionCookie('hd', 'tok', { maxAgeSeconds: 60, secure: true })).toContain(
      '; Secure',
    );
    expect(clearSessionCookie('hd', false)).toContain('Max-Age=0');
  });
});

describe('in-process gate (cheap pre-filter)', () => {
  it('counts per key inside a window and resets after it', () => {
    const g = createGate(1000);
    expect([g.hit('a', 0), g.hit('a', 10), g.hit('b', 10), g.hit('a', 999)]).toEqual([1, 2, 1, 3]);
    expect(g.hit('a', 1000)).toBe(1);
  });
  it('memory stays bounded when an attacker mints 200 000 distinct keys', () => {
    const g = createGate(60_000, 1_000);
    for (let i = 0; i < 200_000; i += 1) g.hit(`k${i}`, 5);
    expect(g.size()).toBeLessThanOrEqual(1_000);
  });
});

describe('semaphore (bounded argon2 concurrency)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it('never runs more than max at once, queues up to queueMax, refuses the rest instantly', async () => {
    const s = createSemaphore(2, 3);
    let running = 0;
    let peak = 0;
    const job = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(30);
      running -= 1;
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => s.run(job)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof Busy)).toHaveLength(
      5,
    );
    expect(peak).toBe(2);
    expect(s.stats()).toEqual({ active: 0, waiting: 0 });
  });
  it('releases its slot when the job throws', async () => {
    const s = createSemaphore(1, 0);
    await expect(
      s.run(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    await expect(s.run(async () => 7)).resolves.toBe(7);
  });
});

describe('CSRF decision', () => {
  const policy = buildOriginPolicy(['http://localhost:3000', 'https://app.example.com/']);
  it.each([
    ['POST', { origin: 'http://localhost:3000' }, true],
    ['POST', { origin: 'https://app.example.com' }, true],
    ['POST', { origin: 'https://evil.example' }, false],
    ['POST', { origin: 'null' }, false],
    ['POST', { origin: '' }, false],
    ['POST', { origin: 'http://localhost:3000.evil.com' }, false],
    ['POST', { origin: 'http://localhost:3001' }, false],
    ['PATCH', { origin: 'http://evil' }, false],
    ['DELETE', { origin: 'http://evil' }, false],
    ['POST', { secFetchSite: 'cross-site' }, false],
    ['POST', { secFetchSite: 'same-site' }, false],
    ['POST', { secFetchSite: 'same-origin' }, true],
    ['POST', { secFetchSite: 'none' }, true],
    ['POST', {}, true],
    ['GET', { origin: 'http://evil' }, true],
    ['OPTIONS', { origin: 'http://evil' }, true],
  ] as const)('%s %j → %s', (method, headers, expected) => {
    expect(csrfAllows(method, headers, policy)).toBe(expected);
  });
});

describe('mapError: every thrown thing becomes a safe envelope', () => {
  it('ZodError → 400 with per-field details', () => {
    const r = z.object({ a: z.string() }).safeParse({ a: 1 });
    const m = mapError((r as { error: ZodError }).error, 'rid');
    expect(m.status).toBe(400);
    expect(m.body).toMatchObject({ code: 'validation_error', requestId: 'rid' });
    expect(m.body.details?.[0]?.path).toBe('a');
  });
  it('HttpException keeps its status/code; 429 carries Retry-After', () => {
    const m = mapError(
      new HttpException({ code: 'rate_limited', message: 'slow down', retryAfterSeconds: 7 }, 429),
      undefined,
    );
    expect(m).toMatchObject({ status: 429, headers: { 'Retry-After': '7' } });
    expect(m.body.code).toBe('rate_limited');
    expect(mapError(new HttpException('Forbidden', 403), undefined).body.code).toBe('forbidden');
    expect(
      mapError(new HttpException('Unexpected token x in JSON', 400), undefined).body.message,
    ).toBe('Bad request');
  });
  it('PostgreSQL data errors are 4xx (NUL byte, bad uuid, constraint), unique violation 409', () => {
    const pg = (code: string) => Object.assign(new Error('boom'), { code });
    expect(mapError(pg('22021'), undefined).status).toBe(400);
    expect(mapError(pg('22P02'), undefined).status).toBe(400);
    expect(mapError(pg('23514'), undefined).status).toBe(400);
    expect(mapError(pg('23505'), undefined).status).toBe(409);
    expect(
      mapError(Object.assign(new Error('wrapped'), { cause: pg('22021') }), undefined).status,
    ).toBe(400);
  });
  it('database trouble is 503 (not 500) and tells the client to retry', () => {
    const pg = (code: string) => Object.assign(new Error('x'), { code });
    for (const code of ['57014', '08006', '53300', '57P01', '3D000'])
      expect(mapError(pg(code), undefined).status, code).toBe(503);
    expect(
      mapError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), undefined).status,
    ).toBe(503);
    expect(mapError(new Error('Connection terminated unexpectedly'), undefined).status).toBe(503);
    expect(mapError(new Error('timeout exceeded when trying to connect'), undefined).status).toBe(
      503,
    );
  });
  it('body-parser style errors keep their 4xx status', () => {
    expect(mapError(Object.assign(new Error('too large'), { status: 413 }), undefined).status).toBe(
      413,
    );
    expect(mapError(Object.assign(new Error('enc'), { statusCode: 415 }), undefined).status).toBe(
      415,
    );
    expect(
      mapError(Object.assign(new SyntaxError('Unexpected token'), { status: 400 }), undefined)
        .status,
    ).toBe(400);
  });
  it('unknown faults are 500 and leak NOTHING about the cause', () => {
    const m = mapError(
      new Error('SELECT * FROM users WHERE password = /etc/passwd at secret.ts:1'),
      'rid',
    );
    expect(m.status).toBe(500);
    expect(JSON.stringify(m.body)).not.toMatch(/SELECT|passwd|secret/);
    expect(mapError('a string', undefined).status).toBe(500);
    expect(mapError(null, undefined).status).toBe(500);
    expect(mapError(undefined, undefined).status).toBe(500);
  });
});

describe('session tokens', () => {
  it('tokens are 256-bit, unique, well formed; only the hash is stored', () => {
    const a = newToken();
    expect(isWellFormedToken(a)).toBe(true);
    expect(a).toHaveLength(43);
    expect(new Set(Array.from({ length: 1000 }, newToken)).size).toBe(1000);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toBe(a);
  });
  it.each([
    '',
    'short',
    'x'.repeat(44),
    `${'a'.repeat(42)}!`,
    `${'a'.repeat(42)}\n`,
    '../../etc/passwd',
    "' OR 1=1 --",
  ])('rejects malformed token %j', (t) => {
    expect(isWellFormedToken(t)).toBe(false);
  });
});
