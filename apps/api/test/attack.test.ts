import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  createUsers,
  login,
  pct,
  pool,
  request,
  sessionCookie,
  startApi,
  type Api,
  type TestUsers,
} from './harness';

/**
 * A malicious user against the REAL server. Each attacker has its own source address (127.x.y.z are all
 * local on Linux). Every scenario asserts two things: the attacker is stopped, AND innocent users are not.
 */
describe('malicious client vs. real server', () => {
  let t: TestDb;
  let u: TestUsers;
  let api: Api; // limits small enough to hit quickly
  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '100',
      RATE_LIMIT_USER_PER_MIN: '1000',
      LOGIN_IP_MAX_FAILURES: '10',
      LOGIN_PAIR_MAX_FAILURES: '5',
      LOGIN_IP_HARD_MAX_FAILURES: '40',
      LOGIN_PAIR_HARD_MAX_FAILURES: '12',
      LOGIN_MAX_CONCURRENCY: '2',
      LOGIN_QUEUE_MAX: '4',
      HEADERS_TIMEOUT_MS: '1500',
      REQUEST_TIMEOUT_MS: '3000',
      KEEP_ALIVE_TIMEOUT_MS: '1000',
    });
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });

  const victimLogsIn = async (from: string) => {
    const r = await login(api, u.customer.email, PASSWORDS.customer, from);
    expect(r.status, `victim at ${from} must not be locked out`).toBe(200);
    const me = await request(api, { path: '/me', cookie: sessionCookie(r)!, from });
    expect(me.status).toBe(200);
  };

  describe('flooding', () => {
    it('one IP hammering the API is cut off at its quota (429 + Retry-After) while an innocent IP is served normally throughout', async () => {
      const attacker = '127.0.0.2';
      const innocent = '127.0.0.3';
      const baseline = await login(api, u.customer.email, PASSWORDS.customer, innocent);
      expect(baseline.status).toBe(200);
      const cookie = sessionCookie(baseline)!;

      const floodPromise = pool(6000, 100, async () =>
        request(api, { path: '/me', from: attacker }),
      );
      // the innocent user keeps working at a human pace, concurrently with the flood
      const probes = await pool(30, 1, async () => {
        await new Promise((res) => setTimeout(res, 20));
        return request(api, { path: '/me', cookie, from: innocent });
      });
      const results = await floodPromise;

      const passed = results.filter((r) => r.status !== 429).length;
      const limited = results.filter((r) => r.status === 429);
      expect(passed).toBeLessThanOrEqual(100);
      expect(limited.length).toBeGreaterThanOrEqual(5800);
      expect(limited[0]?.headers['retry-after']).toMatch(/^\d+$/);
      expect(limited[0]?.json).toMatchObject({ error: { code: 'rate_limited', status: 429 } });

      expect(
        probes.map((p) => p.status),
        'innocent user during the flood',
      ).toEqual(Array(30).fill(200));
      expect(
        pct(
          probes.map((p) => p.ms),
          95,
        ),
        'innocent p95 latency during the flood',
      ).toBeLessThan(1000);
    });

    it('250 parallel requests against a quota of 100 → exactly 100 get through (no race overshoot)', async () => {
      const rs = await Promise.all(
        Array.from({ length: 250 }, () => request(api, { path: '/me', from: '127.0.0.4' })),
      );
      expect(rs.filter((r) => r.status !== 429)).toHaveLength(100);
    });

    it('the quota is per client: a different address is unaffected by someone else being blocked', async () => {
      for (let i = 0; i < 120; i += 1) await request(api, { path: '/me', from: '127.0.0.5' });
      expect((await request(api, { path: '/me', from: '127.0.0.5' })).status).toBe(429);
      expect((await request(api, { path: '/me', from: '127.0.0.6' })).status).toBe(401); // reached auth, not throttled
    });

    it('rate-limit headers tell honest clients where they stand', async () => {
      const r = await request(api, { path: '/ready', from: '127.0.0.7' });
      expect(Number(r.headers['ratelimit-limit'])).toBe(100);
      expect(Number(r.headers['ratelimit-remaining'])).toBe(99);
    });

    it('/health is liveness only: it stays answerable even when the client is over quota', async () => {
      for (let i = 0; i < 120; i += 1) await request(api, { path: '/me', from: '127.0.0.8' });
      expect((await request(api, { path: '/me', from: '127.0.0.8' })).status).toBe(429);
    });
  });

  describe('login attacks', () => {
    it('brute force: after 5 wrong guesses further WRONG guesses from that address get 429 — the victim from another address is unaffected', async () => {
      const attacker = '127.0.0.10';
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1)
        statuses.push((await login(api, u.customer.email, `guess-${i}`, attacker)).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      const throttled = await login(api, u.customer.email, 'guess-6', attacker);
      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBeDefined();
      await victimLogsIn('127.0.0.11');
    });

    it('a victim behind the SAME address as the attacker still signs in with the right password (5 wrong guesses at the account)', async () => {
      const shared = '127.0.0.30';
      for (let i = 0; i < 5; i += 1) await login(api, u.customer.email, `guess-${i}`, shared);
      await victimLogsIn(shared);
    });

    it('a victim behind the SAME address as the attacker still signs in after 20 wrong guesses at other accounts', async () => {
      const shared = '127.0.0.31';
      for (let i = 0; i < 20; i += 1) await login(api, `other${i}@t.test`, 'Password1!', shared);
      await victimLogsIn(shared);
    });

    it('the HARD cap still bounds guessing: past it even the correct password is refused unchecked', async () => {
      const attacker = '127.0.0.32';
      for (let i = 0; i < 12; i += 1) await login(api, u.customer.email, `guess-${i}`, attacker);
      const refused = await login(api, u.customer.email, PASSWORDS.customer, attacker);
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBeDefined();
      await victimLogsIn('127.0.0.33');
    });

    it('credential stuffing: exactly 10 attempts per address, then 429 for every account', async () => {
      const attacker = '127.0.0.12';
      const statuses: number[] = [];
      for (let i = 0; i < 25; i += 1)
        statuses.push((await login(api, `victim${i}@t.test`, 'Password1!', attacker)).status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
      // past the soft limit only WRONG guesses are throttled; the owner of a right password is not locked out
      expect((await login(api, u.agent.email, PASSWORDS.agent, attacker)).status).toBe(200);
      await victimLogsIn('127.0.0.13');
    });

    it('50 PARALLEL guesses from one address: the budget cannot be overshot by racing (attempts are reserved before checking)', async () => {
      const rs = await Promise.all(
        Array.from({ length: 50 }, (_, i) => login(api, u.lead.email, `race-${i}`, '127.0.0.14')),
      );
      const checked = rs.filter((r) => r.status === 401).length;
      expect(checked).toBeLessThanOrEqual(5); // pair budget
      expect(rs.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    });

    it('password spraying across 40 addresses neither locks the account out nor crashes anything', async () => {
      const rs = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          login(api, u.customer.email, 'Summer2026!', `127.0.1.${i + 1}`),
        ),
      );
      // each address has its own budget; most are checked (401); the argon2 gate may shed a few (429)
      expect(rs.every((r) => r.status === 401 || r.status === 429)).toBe(true);
      await victimLogsIn('127.0.0.15'); // the victim is NOT locked out by the spray
    });

    it('a successful login does not eat the failure budget (office NAT: many legitimate logins from one address)', async () => {
      for (let i = 0; i < 15; i += 1)
        expect((await login(api, u.customer.email, PASSWORDS.customer, '127.0.0.16')).status).toBe(
          200,
        );
    });

    it('a user who mistypes once and then succeeds starts clean', async () => {
      const ip = '127.0.0.17';
      for (let i = 0; i < 4; i += 1) await login(api, u.agent.email, 'typo', ip);
      expect((await login(api, u.agent.email, PASSWORDS.agent, ip)).status).toBe(200);
      for (let i = 0; i < 4; i += 1)
        expect((await login(api, u.agent.email, 'typo', ip)).status).toBe(401);
    });

    it('distributed flood of 60 simultaneous logins (60 addresses): expensive hashing is bounded, the API stays responsive', async () => {
      let done = false;
      const healthLatency: number[] = [];
      const probe = (async () => {
        while (!done) {
          healthLatency.push((await request(api, { path: '/health', from: '127.0.0.30' })).ms);
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      const rs = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          login(api, `bot${i}@t.test`, 'x'.repeat(100), `127.0.2.${i + 1}`),
        ),
      );
      done = true;
      await probe;
      expect(rs.every((r) => r.status === 401 || r.status === 429)).toBe(true);
      expect(
        rs.filter((r) => r.status === 429).length,
        'excess work must be refused, not queued forever',
      ).toBeGreaterThan(0);
      expect(pct(healthLatency, 95), '/health p95 during the login flood').toBeLessThan(500);
      // a legitimate user gets in within a few polite retries
      let ok = false;
      for (let i = 0; i < 8 && !ok; i += 1) {
        ok = (await login(api, u.customer.email, PASSWORDS.customer, '127.0.0.31')).status === 200;
        if (!ok) await new Promise((r) => setTimeout(r, 300));
      }
      expect(ok).toBe(true);
    });

    it('1 MB-password bodies from 40 clients at once are rejected cheaply (no hashing, no memory blow-up)', async () => {
      const big = 'x'.repeat(1_000_000);
      const started = Date.now();
      const rs = await Promise.all(
        Array.from({ length: 40 }, (_, i) => login(api, u.agent.email, big, `127.0.3.${i + 1}`)),
      );
      expect(rs.every((r) => r.status === 413)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((await request(api, { path: '/ready', from: '127.0.0.32' })).status).toBe(200);
    });
  });

  describe('forged client addresses (X-Forwarded-For & friends)', () => {
    const spoofHeaders = (ip: string) => ({
      'x-forwarded-for': ip,
      'x-real-ip': ip,
      forwarded: `for=${ip}`,
      'x-client-ip': ip,
      'cf-connecting-ip': ip,
      'true-client-ip': ip,
    });

    it('rotating a spoofed X-Forwarded-For per request does NOT evade the login budget', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        statuses.push(
          (
            await login(api, `spoof${i}@t.test`, 'x', '127.0.0.18', {
              headers: spoofHeaders(`198.51.100.${i + 1}`),
            })
          ).status,
        );
      }
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    });

    it('rotating spoofed headers does NOT evade the general API quota either', async () => {
      const rs = await pool(250, 25, async (i) =>
        request(api, {
          path: '/me',
          from: '127.0.0.19',
          headers: spoofHeaders(`203.0.113.${(i % 250) + 1}`),
        }),
      );
      expect(rs.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(100);
    });

    it("naming the VICTIM's address in the header cannot poison the victim's budget", async () => {
      const victimIp = '127.0.0.21';
      for (let i = 0; i < 40; i += 1)
        await login(api, u.customer.email, `poison-${i}`, '127.0.0.20', {
          headers: spoofHeaders(victimIp),
        });
      await victimLogsIn(victimIp);
    });
  });

  describe('trusted reverse proxy configured (TRUSTED_PROXIES=127.0.0.100)', () => {
    let proxied: Api;
    beforeAll(async () => {
      proxied = await startApi(t.url, {
        TRUSTED_PROXIES: '127.0.0.100',
        LOGIN_IP_MAX_FAILURES: '4',
        LOGIN_PAIR_MAX_FAILURES: '4',
        RATE_LIMIT_API_PER_MIN: '100000',
      });
    });
    afterAll(async () => {
      await proxied.stop();
    });
    const viaProxy = (email: string, xff: string, from = '127.0.0.100') =>
      login(proxied, email, 'wrong', from, { headers: { 'x-forwarded-for': xff } });

    it('the real client behind the proxy is what gets limited; another client behind the same proxy is not', async () => {
      const s = [];
      for (let i = 0; i < 6; i += 1) s.push((await viaProxy('a@t.test', '198.51.100.7')).status);
      expect(s).toEqual([401, 401, 401, 401, 429, 429]);
      expect((await viaProxy('a@t.test', '198.51.100.8')).status).toBe(401);
    });
    it('a spoofed prefix added by the client is ignored: the rightmost untrusted hop is used', async () => {
      // client 198.51.100.50 claims to be 9.9.9.x; the proxy appends the address it really saw
      const s = [];
      for (let i = 0; i < 6; i += 1)
        s.push((await viaProxy('b@t.test', `9.9.9.${i}, 198.51.100.50`)).status);
      expect(s).toEqual([401, 401, 401, 401, 429, 429]);
    });
    it("the same header from an UNtrusted peer is ignored (cannot impersonate the proxy's clients)", async () => {
      for (let i = 0; i < 12; i += 1) await viaProxy('c@t.test', '198.51.100.99', '127.0.0.101');
      // 198.51.100.99 as seen via the trusted proxy was never touched by the untrusted peer
      expect((await viaProxy('c@t.test', '198.51.100.99')).status).toBe(401);
    });
  });

  describe('connection-level attacks', () => {
    it('slowloris: sockets that dribble headers are dropped after HEADERS_TIMEOUT while real users are served', async () => {
      const socks: net.Socket[] = [];
      const closedAt: number[] = [];
      const t0 = Date.now();
      for (let i = 0; i < 40; i += 1) {
        const s = net.connect({ host: '127.0.0.1', port: api.port, localAddress: '127.0.0.40' });
        s.on('error', () => undefined);
        s.resume(); // read (and discard) whatever the server answers, or 'close' is never delivered
        s.on('close', () => closedAt.push(Date.now() - t0));
        s.on('connect', () => s.write('GET /health HTTP/1.1\r\nHost: x\r\nX-Slow: '));
        socks.push(s);
      }
      const drip = setInterval(() => socks.forEach((s) => !s.destroyed && s.write('a')), 200);
      // while they hold 40 connections open, a normal client is fine
      for (let i = 0; i < 5; i += 1)
        expect((await request(api, { path: '/health', from: '127.0.0.41' })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 4_500));
      clearInterval(drip);
      socks.forEach((s) => s.destroy());
      expect(closedAt.length).toBe(40);
      expect(Math.max(...closedAt), 'all slow sockets are gone within a few seconds').toBeLessThan(
        5_500,
      );
    });

    it('slow body: a client that promises 100 bytes and sends 5 is cut off', async () => {
      const closed = await new Promise<number>((resolve) => {
        const t0 = Date.now();
        const s = net.connect({ host: '127.0.0.1', port: api.port, localAddress: '127.0.0.42' });
        s.on('error', () => undefined);
        s.resume();
        s.on('close', () => resolve(Date.now() - t0));
        s.on('connect', () =>
          s.write(
            'POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"ema',
          ),
        );
        setTimeout(() => resolve(-1), 9_000).unref();
      });
      expect(closed).toBeGreaterThan(0);
      expect(closed).toBeLessThan(8_000);
    });

    it('300 idle connections from one address do not stop other users', async () => {
      const socks = await Promise.all(
        Array.from(
          { length: 300 },
          () =>
            new Promise<net.Socket>((resolve) => {
              const s = net.connect(
                { host: '127.0.0.1', port: api.port, localAddress: '127.0.0.43' },
                () => resolve(s),
              );
              s.on('error', () => undefined);
            }),
        ),
      );
      const r = await request(api, { path: '/ready', from: '127.0.0.44' });
      socks.forEach((s) => s.destroy());
      expect(r.status).toBe(200);
      expect(r.ms).toBeLessThan(500);
    });
  });

  describe('housekeeping', () => {
    it('forged headers never become limiter keys — only real source addresses do — and the server still answers', async () => {
      const keys = (await t.db.execute<{ key: string }>(sql`SELECT key FROM rate_limits`)).rows.map(
        (r) => r.key,
      );
      expect(keys.length).toBeGreaterThan(50);
      expect(
        keys
          .filter((k) => /198\.51\.100|203\.0\.113|9\.9\.9/.test(k) && !/127\.0\.0\.100/.test(k))
          .filter(
            (k) =>
              !k.includes('198.51.100.7') &&
              !k.includes('198.51.100.8') &&
              !k.includes('198.51.100.50') &&
              !k.includes('198.51.100.99'),
          ),
      ).toEqual([]);
      expect((await request(api, { path: '/ready', from: '127.0.0.99' })).status).toBe(200);
    });
  });
});
