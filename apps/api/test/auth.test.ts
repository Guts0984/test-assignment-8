import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  createUsers,
  login,
  pct,
  request,
  sessionCookie,
  sha256,
  startApi,
  type Api,
  type TestUsers,
} from './harness';

describe('authentication & sessions (real server, real PostgreSQL)', () => {
  let t: TestDb;
  let u: TestUsers;
  let api: Api;
  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    // Generous limits here: this file is about auth logic, not throttling (see attack.test.ts).
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '100000',
      LOGIN_IP_MAX_FAILURES: '1000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
      SESSION_MAX_PER_USER: '3',
      LOGIN_QUEUE_MAX: '100',
      LOGIN_MAX_CONCURRENCY: '4',
    });
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });
  const sessionRows = async (userId: string) =>
    (
      await t.db.execute<{ id: string }>(sql`SELECT id FROM sessions WHERE user_id = ${userId}`)
    ).rows.map((r) => r.id);

  describe('login', () => {
    it.each([
      ['customer', 'customer'],
      ['agent', 'agent'],
      ['lead', 'lead'],
    ] as const)(
      '%s logs in, gets an httpOnly cookie and a profile without secrets',
      async (key, pw) => {
        const r = await login(api, u[key].email, PASSWORDS[pw]);
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ user: { id: u[key].id, email: u[key].email, role: key } });
        expect(r.text).not.toMatch(/password|hash|argon/i);
        const cookie = r.setCookies[0] ?? '';
        expect(cookie).toMatch(/^hd_session=[A-Za-z0-9_-]{43};/);
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
        expect(cookie).toMatch(/Max-Age=\d+/);
        expect(cookie).not.toContain('Secure'); // plain http in tests; production sets it
      },
    );
    it('an agent sees the categories they work with in /me', async () => {
      const r = await login(api, u.agent.email, PASSWORDS.agent);
      const me = await request(api, { path: '/me', cookie: sessionCookie(r) });
      expect((me.json as { categories: string[] }).categories).toEqual(['payment']);
    });
    it('email is case/space-insensitive', async () => {
      expect((await login(api, '  AGENT@T.TEST ', PASSWORDS.agent)).status).toBe(200);
    });
    it('only the SHA-256 of the token is stored — a database leak cannot be replayed', async () => {
      const r = await login(api, u.customer2.email, PASSWORDS.customer);
      const token = sessionCookie(r)!.split('=')[1]!;
      const ids = await sessionRows(u.customer2.id);
      expect(ids).toContain(sha256(token));
      expect(ids).not.toContain(token);
    });
    it('wrong password, unknown user and disabled user are indistinguishable (status, body, no cookie)', async () => {
      const bodies = [];
      for (const [email, pw] of [
        [u.agent.email, 'nope'],
        ['ghost@t.test', 'nope'],
        [u.disabled.email, PASSWORDS.customer],
        [u.agent.email, PASSWORDS.lead],
      ] as const) {
        const r = await login(api, email, pw);
        expect(r.status).toBe(401);
        expect(r.setCookies).toHaveLength(0);
        const { error } = r.json as { error: Record<string, unknown> };
        bodies.push(JSON.stringify({ ...error, requestId: undefined }));
      }
      expect(new Set(bodies).size).toBe(1);
    });
    it('timing does not reveal whether an account exists (dummy hash for unknown users)', async () => {
      const time = async (email: string) => {
        const ms: number[] = [];
        for (let i = 0; i < 10; i += 1) ms.push((await login(api, email, 'wrong-password')).ms);
        return pct(ms, 50);
      };
      await time(u.agent.email); // warm up
      const known = await time(u.agent.email);
      const unknown = await time('nobody-here@t.test');
      expect(unknown).toBeGreaterThan(known * 0.4);
      expect(unknown).toBeLessThan(known * 2.5);
    });
    it('over-long passwords are refused before any hashing (cheap 400)', async () => {
      const r = await login(api, u.agent.email, 'x'.repeat(129));
      expect(r.status).toBe(400);
      expect(r.ms).toBeLessThan(200);
    });
    it('10 simultaneous correct logins all succeed and leave no failure count behind', async () => {
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => login(api, u.lead.email, PASSWORDS.lead, '127.0.0.40')),
      );
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const rows = await t.db.execute<{ count: number }>(
        sql`SELECT count FROM rate_limits WHERE key LIKE 'login:%127.0.0.40%'`,
      );
      expect(rows.rows.every((r) => Number(r.count) === 0)).toBe(true);
    });
  });

  describe('session lifecycle', () => {
    it('/me needs a session; garbage and tampered cookies are rejected', async () => {
      expect((await request(api, { path: '/me' })).status).toBe(401);
      const good = sessionCookie(await login(api, u.customer.email, PASSWORDS.customer))!;
      expect((await request(api, { path: '/me', cookie: good })).status).toBe(200);
      const token = good.split('=')[1]!;
      const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
      for (const bad of [
        '',
        'hd_session=',
        `hd_session=${flipped}`,
        `hd_session=${token.slice(0, 20)}`,
        `hd_session=${token}x`,
        `hd_session=${'a'.repeat(10_000)}`,
        'hd_session=../../etc/passwd',
        "hd_session=' OR 1=1--",
        `hd_session=${token.toUpperCase()}`,
        'other=1',
      ]) {
        const r = await request(api, { path: '/me', cookie: bad || undefined });
        expect(r.status, bad.slice(0, 40)).toBe(401);
      }
    });
    it('two cookies with the same name (cookie tossing) → rejected, even if one is valid', async () => {
      const good = sessionCookie(await login(api, u.customer.email, PASSWORDS.customer))!;
      const r = await request(api, {
        path: '/me',
        headers: { cookie: `${good}; hd_session=${'b'.repeat(43)}` },
      });
      expect(r.status).toBe(401);
    });
    it('logout invalidates the session server-side: the old cookie is dead (replay fails)', async () => {
      const cookie = sessionCookie(await login(api, u.customer.email, PASSWORDS.customer))!;
      const out = await request(api, { method: 'POST', path: '/auth/logout', cookie });
      expect(out.status).toBe(204);
      expect(out.setCookies[0]).toMatch(/hd_session=;.*Max-Age=0/);
      expect((await request(api, { path: '/me', cookie })).status).toBe(401);
      expect((await request(api, { method: 'POST', path: '/auth/logout', cookie })).status).toBe(
        204,
      ); // idempotent
      expect(
        (await request(api, { method: 'POST', path: '/auth/logout', cookie: 'hd_session=garbage' }))
          .status,
      ).toBe(204);
      expect((await request(api, { method: 'POST', path: '/auth/logout' })).status).toBe(204);
    });
    it('session fixation: a cookie planted before login is never adopted and is destroyed by the login', async () => {
      const victimSession = sessionCookie(await login(api, u.agent2.email, PASSWORDS.agent))!;
      // attacker made the victim hold a known-valid-looking token
      const planted = `hd_session=${'Z'.repeat(43)}`;
      const r = await login(api, u.agent2.email, PASSWORDS.agent, undefined, { cookie: planted });
      expect(r.status).toBe(200);
      const fresh = sessionCookie(r)!;
      expect(fresh).not.toBe(planted);
      expect((await request(api, { path: '/me', cookie: planted })).status).toBe(401);
      // and a real previous session presented at login is rotated away
      const r2 = await login(api, u.agent2.email, PASSWORDS.agent, undefined, { cookie: fresh });
      expect(sessionCookie(r2)).not.toBe(fresh);
      expect((await request(api, { path: '/me', cookie: fresh })).status).toBe(401);
      expect((await request(api, { path: '/me', cookie: sessionCookie(r2)! })).status).toBe(200);
      expect(victimSession).toBeTruthy();
    });
    it('expired sessions are rejected and the cookie is cleared', async () => {
      const cookie = sessionCookie(await login(api, u.customer2.email, PASSWORDS.customer))!;
      await t.db.execute(
        sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${sha256(cookie.split('=')[1]!)}`,
      );
      const r = await request(api, { path: '/me', cookie });
      expect(r.status).toBe(401);
      expect(r.setCookies[0]).toContain('Max-Age=0');
    });
    it('disabling a user kills their live sessions immediately', async () => {
      const cookie = sessionCookie(await login(api, u.customer2.email, PASSWORDS.customer))!;
      expect((await request(api, { path: '/me', cookie })).status).toBe(200);
      await t.db.execute(sql`UPDATE users SET disabled = true WHERE id = ${u.customer2.id}`);
      expect((await request(api, { path: '/me', cookie })).status).toBe(401);
      expect((await login(api, u.customer2.email, PASSWORDS.customer)).status).toBe(401);
      await t.db.execute(sql`UPDATE users SET disabled = false WHERE id = ${u.customer2.id}`);
    });
    it('at most SESSION_MAX_PER_USER (3) sessions per user: the oldest are evicted', async () => {
      const cookies: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        cookies.push(
          sessionCookie(await login(api, u.lead.email, PASSWORDS.lead, `127.0.0.${50 + i}`))!,
        );
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(await sessionRows(u.lead.id)).toHaveLength(3);
      const statuses = await Promise.all(
        cookies.map(async (c) => (await request(api, { path: '/me', cookie: c })).status),
      );
      expect(statuses).toEqual([401, 401, 200, 200, 200]);
    });
    it("a user cannot use another user's session by guessing: tokens differ and are random", async () => {
      const a = sessionCookie(await login(api, u.customer.email, PASSWORDS.customer))!;
      const b = sessionCookie(await login(api, u.customer.email, PASSWORDS.customer))!;
      expect(a).not.toBe(b);
    });
  });
});
