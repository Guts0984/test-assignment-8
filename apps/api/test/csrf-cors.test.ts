import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import {
  PASSWORDS,
  createUsers,
  request,
  sessionCookie,
  startApi,
  login,
  type Api,
  type TestUsers,
} from './harness';

const GOOD = 'http://localhost:3000';

describe("CSRF and CORS (a malicious web page in the victim's browser)", () => {
  let t: TestDb;
  let u: TestUsers;
  let api: Api;
  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      CORS_ORIGINS: `${GOOD},https://helpdesk.example.com`,
      RATE_LIMIT_API_PER_MIN: '100000',
      LOGIN_IP_MAX_FAILURES: '1000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
    });
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });
  const creds = () => ({ email: u.customer.email, password: PASSWORDS.customer });

  describe('state-changing requests', () => {
    it.each([
      ['evil site', { origin: 'https://evil.example' }],
      ['"null" origin (sandboxed iframe / redirect)', { origin: 'null' }],
      ['look-alike suffix', { origin: 'http://localhost:3000.evil.com' }],
      ['look-alike prefix', { origin: 'http://evil-localhost:3000' }],
      ['same host other port', { origin: 'http://localhost:3001' }],
      ['scheme downgrade', { origin: 'http://helpdesk.example.com' }],
      ['empty origin', { origin: '' }],
      ['no Origin but browser says cross-site', { 'sec-fetch-site': 'cross-site' }],
      [
        'no Origin but browser says same-site (sibling subdomain)',
        { 'sec-fetch-site': 'same-site' },
      ],
    ])('login CSRF from %s is blocked with 403 and sets no cookie', async (_n, headers) => {
      const r = await request(api, { method: 'POST', path: '/auth/login', body: creds(), headers });
      expect(r.status).toBe(403);
      expect(r.setCookies).toHaveLength(0);
      expect(r.json).toMatchObject({ error: { code: 'forbidden' } });
    });

    it('a forged logout / PATCH / DELETE from a foreign origin is blocked before reaching any handler', async () => {
      const cookie = sessionCookie(
        await login(api, u.customer.email, PASSWORDS.customer, undefined, {
          headers: { origin: GOOD },
        }),
      )!;
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const r = await request(api, {
          method,
          path: '/auth/logout',
          cookie,
          headers: { origin: 'https://evil.example' },
          body: {},
        });
        expect(r.status, method).toBe(403);
      }
      expect((await request(api, { path: '/me', cookie })).status).toBe(200); // session survived the attack
    });

    it.each([
      [GOOD],
      ['https://helpdesk.example.com'],
      ['HTTP://LOCALHOST:3000'],
      ['http://localhost:3000/'],
    ])('the real web app (%s) works', async (origin) => {
      const r = await request(api, {
        method: 'POST',
        path: '/auth/login',
        body: creds(),
        headers: { origin },
      });
      expect(r.status).toBe(200);
    });

    it('non-browser clients (no Origin, no Sec-Fetch-Site) work — they carry no ambient cookie to abuse', async () => {
      expect(
        (await request(api, { method: 'POST', path: '/auth/login', body: creds() })).status,
      ).toBe(200);
      expect(
        (
          await request(api, {
            method: 'POST',
            path: '/auth/login',
            body: creds(),
            headers: { 'sec-fetch-site': 'same-origin' },
          })
        ).status,
      ).toBe(200);
    });

    it('a cross-site <form> cannot log the victim in as someone else (text/plain / urlencoded bodies are never parsed)', async () => {
      for (const [type, body] of [
        ['text/plain', JSON.stringify(creds())],
        [
          'application/x-www-form-urlencoded',
          `email=${u.customer.email}&password=${PASSWORDS.customer}`,
        ],
      ] as const) {
        const r = await request(api, {
          method: 'POST',
          path: '/auth/login',
          body,
          headers: { 'content-type': type, origin: GOOD },
        });
        expect(r.status).toBe(400);
        expect(r.setCookies).toHaveLength(0);
      }
    });

    it('GET requests are not blocked by the CSRF check (they must not change state)', async () => {
      expect(
        (await request(api, { path: '/health', headers: { origin: 'https://evil.example' } }))
          .status,
      ).toBe(200);
    });
  });

  describe('CORS', () => {
    const preflight = (origin: string, method = 'POST') =>
      request(api, {
        method: 'OPTIONS',
        path: '/auth/login',
        headers: {
          origin,
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type',
        },
      });

    it('a preflight from an allowed origin returns that exact origin with credentials', async () => {
      const r = await preflight(GOOD);
      expect(r.status).toBeLessThan(300);
      expect(r.headers['access-control-allow-origin']).toBe(GOOD);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
      expect(r.headers.vary).toMatch(/Origin/i);
    });
    it.each([
      'https://evil.example',
      'null',
      'http://localhost:3000.evil.com',
      'http://localhost:3001',
    ])('a preflight from %s gets NO Access-Control-Allow-Origin', async (origin) => {
      const r = await preflight(origin);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    });
    it('responses never use a wildcard origin and never reflect an unknown origin', async () => {
      for (const origin of ['https://evil.example', GOOD]) {
        const r = await request(api, { path: '/me', headers: { origin } });
        expect(r.headers['access-control-allow-origin']).not.toBe('*');
        if (origin !== GOOD) expect(r.headers['access-control-allow-origin']).toBeUndefined();
        else expect(r.headers['access-control-allow-origin']).toBe(GOOD);
      }
    });
    it('only the declared methods are advertised', async () => {
      const r = await preflight(GOOD, 'DELETE');
      expect(r.headers['access-control-allow-methods']).toBeDefined();
      expect(r.headers['access-control-allow-methods']).not.toMatch(/TRACE|CONNECT/);
    });
  });

  describe('cookie hardening', () => {
    it('the session cookie is HttpOnly + SameSite=Lax (a cross-site POST would not carry it even without the Origin check)', async () => {
      const r = await login(api, u.customer.email, PASSWORDS.customer);
      expect(r.setCookies[0]).toMatch(/HttpOnly/);
      expect(r.setCookies[0]).toMatch(/SameSite=Lax/);
    });
    it('in production mode the cookie is also Secure', async () => {
      const prod = await startApi(t.url, { NODE_ENV: 'production', CORS_ORIGINS: GOOD });
      try {
        const r = await login(prod, u.customer.email, PASSWORDS.customer);
        expect(r.setCookies[0]).toMatch(/; Secure/);
      } finally {
        await prod.stop();
      }
    });
  });
});
