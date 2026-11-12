import { expect, test } from '@playwright/test';

/** The deployed stack: everything on one port behind nginx. */
test.describe('nginx entry point', () => {
  test('web at /, api at /api, Swagger at /docs, one origin', async ({ request, baseURL }) => {
    const home = await request.get('/login');
    expect(home.status()).toBe(200);
    expect(await home.text()).toContain('<html');
    expect(home.headers()['server']).toBe('nginx'); // no version leaked
    const health = await request.get('/api/health');
    expect(await health.json()).toEqual({ status: 'ok' });
    expect((await request.get('/api/ready')).status()).toBe(200);
    expect((await request.get('/docs')).status()).toBe(200);
    expect(baseURL).toMatch(/:8080$/);
  });

  test('a spoofed X-Forwarded-For does not change who the api thinks you are', async ({
    request,
  }) => {
    const remaining = async (xff: string) =>
      Number(
        (await request.get('/api/me', { headers: { 'x-forwarded-for': xff } })).headers()[
          'ratelimit-remaining'
        ],
      );
    const first = await remaining('203.0.113.1');
    const second = await remaining('203.0.113.2');
    const third = await remaining('198.51.100.9');
    // the same real client, so one shared counter that only goes down — three "devices" would each start fresh
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
  });

  test('the session cookie is set by the api through nginx and the CSRF Origin check still applies', async ({
    request,
    baseURL,
  }) => {
    const ok = await request.post('/api/auth/login', {
      data: { email: 'lead@helpdesk.test', password: 'Lead#2026pass' },
      headers: { origin: baseURL! },
    });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['set-cookie']).toMatch(/hd_session=.*HttpOnly/);
    const evil = await request.post('/api/auth/login', {
      data: { email: 'lead@helpdesk.test', password: 'Lead#2026pass' },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status()).toBe(403);
  });
});
