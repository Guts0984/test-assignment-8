import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import {
  PASSWORDS,
  as,
  createUsers,
  freePort,
  openEvents,
  request,
  startApi,
  type Api,
  type Session,
  type TestUsers,
} from './harness';

/**
 * The REAL docker/nginx/default.conf in front of a REAL api process. Clients come from different loopback addresses
 * (127.0.0.x) and nginx runs with host networking, so it sees those source addresses — exactly what separate devices are.
 */
const dockerOk = (() => {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  return r.status === 0;
})();
const CONF = path.resolve(__dirname, '../../../docker/nginx/default.conf');

const startNginx = async (apiPort: number, webPort: number) => {
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), 'hd-nginx-'));
  const conf = readFileSync(CONF, 'utf8')
    .replace('server web:3000', `server 127.0.0.1:${webPort}`)
    .replace('server api:3001', `server 127.0.0.1:${apiPort}`)
    .replace('listen 8080;', `listen 127.0.0.1:${port};`);
  writeFileSync(path.join(dir, 'default.conf'), conf);
  const name = `hd-nginx-${randomBytes(4).toString('hex')}`;
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      'host',
      '-v',
      `${path.join(dir, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`,
      'nginx:1.27-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) throw new Error(`nginx did not start: ${run.stderr}`);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await request({ port }, { path: '/api/health' })).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(
        `nginx not ready: ${spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stderr}`,
      );
    await new Promise((r) => setTimeout(r, 150));
  }
  return { port, stop: () => void spawnSync('docker', ['rm', '-f', name]) };
};

/** The api's routes live under /api when reached through nginx. */
const viaLogin = (
  front: Pick<Api, 'port'>,
  email: string,
  password: string,
  from: string,
  headers: Record<string, string> = {},
) =>
  request(front, {
    method: 'POST',
    path: '/api/auth/login',
    body: { email, password },
    from,
    headers,
  });
const viaSession = async (
  front: Pick<Api, 'port'>,
  email: string,
  password: string,
  from: string,
): Promise<Session> => {
  const r = await viaLogin(front, email, password, from);
  if (r.status !== 200) throw new Error(`login via nginx failed: ${r.status} ${r.text}`);
  return {
    cookie: r.setCookies[0]!.split(';')[0]!,
    user: (r.json as { user: Session['user'] }).user,
  };
};

const stubWeb = async () => {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(`web-stub ${req.url}`);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { port, close: () => server.close() };
};

describe.skipIf(!dockerOk)('nginx layer (real config, real api, separate client addresses)', () => {
  let t: TestDb;
  let u: TestUsers;
  let web: Awaited<ReturnType<typeof stubWeb>>;
  const stops: Array<() => unknown> = [];

  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    web = await stubWeb();
  });
  afterAll(async () => {
    for (const s of stops.reverse()) await s();
    web.close();
    await t.drop();
  });

  /** api (trusting 127.0.0.1 like compose trusts its private network) behind nginx */
  const stack = async (env: Record<string, string> = {}) => {
    const api = await startApi(t.url, {
      TRUSTED_PROXIES: '127.0.0.1',
      RATE_LIMIT_API_PER_MIN: '20',
      RATE_LIMIT_USER_PER_MIN: '100000',
      LOGIN_IP_MAX_FAILURES: '10',
      LOGIN_PAIR_MAX_FAILURES: '5',
      CORS_ORIGINS: 'http://localhost:8080',
      ...env,
    });
    stops.push(() => api.stop());
    const nginx = await startNginx(api.port, web.port);
    stops.push(nginx.stop);
    return { api, nginx, front: { port: nginx.port } as Pick<Api, 'port'> };
  };

  it('routes: / → web, /api/* → api (prefix stripped), /api → /api/, /docs → api', async () => {
    const { front } = await stack();
    expect((await request(front, { path: '/' })).text).toBe('web-stub /');
    expect((await request(front, { path: '/queue?x=1' })).text).toBe('web-stub /queue?x=1');
    const health = await request(front, { path: '/api/health' });
    expect(health.json).toEqual({ status: 'ok' });
    expect((await request(front, { path: '/api' })).status).toBe(301);
    expect((await request(front, { path: '/docs' })).status).toBe(200);
    expect((await request(front, { path: '/docs-json' })).text).toContain('/auth/login');
    expect((await request(front, { path: '/api/definitely-missing' })).json).toMatchObject({
      error: { code: 'not_found' },
    });
    expect(health.headers.server).toBe('nginx'); // version hidden (server_tokens off)
  });

  it('each device is counted separately: one address floods and is throttled, another address behind the SAME nginx is untouched', async () => {
    const { front } = await stack();
    const flooder = await Promise.all(
      Array.from({ length: 60 }, () => request(front, { path: '/api/me', from: '127.0.0.2' })),
    );
    expect(flooder.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(35);
    expect(flooder.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(20);
    for (const ip of ['127.0.0.3', '127.0.0.4', '127.0.0.5']) {
      const r = await request(front, { path: '/api/me', from: ip });
      expect(r.status, ip).toBe(401); // reached auth: not throttled
      expect(Number(r.headers['ratelimit-remaining'])).toBe(19); // its own fresh quota
    }
  });

  it('a spoofed X-Forwarded-For does NOT create a new "device": rotating it never escapes the limit, naming a victim never poisons the victim', async () => {
    const { front } = await stack();
    const spoof = (i: number) => ({
      'x-forwarded-for': `203.0.113.${(i % 250) + 1}`,
      'x-real-ip': '198.51.100.7',
      forwarded: 'for=192.0.2.1',
    });
    const rs = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        request(front, { path: '/api/me', from: '127.0.0.6', headers: spoof(i) }),
      ),
    );
    expect(rs.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(20);
    // the attacker claimed to be 127.0.0.7 — the victim's real address — in every request
    for (let i = 0; i < 30; i += 1)
      await request(front, {
        path: '/api/me',
        from: '127.0.0.6',
        headers: { 'x-forwarded-for': '127.0.0.7' },
      });
    const victim = await request(front, { path: '/api/me', from: '127.0.0.7' });
    expect(victim.status).toBe(401);
    expect(Number(victim.headers['ratelimit-remaining'])).toBe(19);
  });

  it('login protection works per device through nginx: an attacker is locked out, the victim on another device logs in', async () => {
    const { front } = await stack({ RATE_LIMIT_API_PER_MIN: '100000' });
    for (let i = 0; i < 5; i += 1)
      expect(
        (
          await viaLogin(front, u.customer.email, `wrong-${i}`, '127.0.0.8', {
            'x-forwarded-for': `9.9.9.${i}`,
          })
        ).status,
      ).toBe(401);
    expect((await viaLogin(front, u.customer.email, PASSWORDS.customer, '127.0.0.8')).status).toBe(
      429,
    );
    expect((await viaLogin(front, u.customer.email, PASSWORDS.customer, '127.0.0.9')).status).toBe(
      200,
    );
  });

  it("WITHOUT trusting the proxy, every user collapses into nginx's own address — which is why compose sets TRUSTED_PROXIES", async () => {
    const { front } = await stack({ TRUSTED_PROXIES: '' });
    await Promise.all(
      Array.from({ length: 40 }, () => request(front, { path: '/api/me', from: '127.0.0.10' })),
    );
    const innocent = await request(front, { path: '/api/me', from: '127.0.0.11' });
    expect(innocent.status).toBe(429); // misconfiguration: one noisy user blocks everybody
  });

  it('cookies and CSRF behave through nginx: the web origin works, a foreign origin is refused, Set-Cookie arrives', async () => {
    const { front } = await stack({ RATE_LIMIT_API_PER_MIN: '100000' });
    const ok = await viaLogin(front, u.agent.email, PASSWORDS.agent, '127.0.0.12', {
      origin: 'http://localhost:8080',
    });
    expect(ok.status).toBe(200);
    expect(ok.setCookies[0]).toMatch(/^hd_session=.*HttpOnly/);
    const evil = await viaLogin(front, u.agent.email, PASSWORDS.agent, '127.0.0.12', {
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
    expect(
      (
        await request(front, {
          path: '/api/me',
          cookie: ok.setCookies[0]!.split(';')[0]!,
          from: '127.0.0.12',
        })
      ).status,
    ).toBe(200);
  });

  it('SSE streams through nginx unbuffered: an event arrives within a moment of the change', async () => {
    const { front } = await stack({ RATE_LIMIT_API_PER_MIN: '100000', SSE_HEARTBEAT_MS: '1000' });
    const customer: Session = await viaSession(
      front,
      u.customer.email,
      PASSWORDS.customer,
      '127.0.0.13',
    );
    const agent: Session = await viaSession(front, u.lead.email, PASSWORDS.lead, '127.0.0.14');
    const stream = await openEvents(front, agent, { path: '/api/events', from: '127.0.0.14' });
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    const started = Date.now();
    const created = await as(front, customer, '127.0.0.13').post('/api/tickets', {
      subject: 'via nginx',
      category: 'other',
      priority: 'normal',
      body: 'b',
      attachmentIds: [],
      clientMessageId: crypto.randomUUID(),
    });
    expect(created.status).toBe(201);
    await stream.waitFor((f) => f.event === 'ticket.created', 5_000);
    expect(
      Date.now() - started,
      'buffering would hold the event for the whole heartbeat/timeout',
    ).toBeLessThan(3_000);
    stream.close();
  });

  it('uploads: nginx refuses absurd bodies early (413), the api still enforces the exact 10 MB limit by itself', async () => {
    const { front } = await stack({ RATE_LIMIT_API_PER_MIN: '100000' });
    const s = await viaSession(front, u.customer.email, PASSWORDS.customer, '127.0.0.15');
    const send = (bytes: number) =>
      request(front, {
        method: 'POST',
        path: '/api/attachments',
        cookie: s.cookie,
        from: '127.0.0.15',
        headers: { 'content-type': 'multipart/form-data; boundary=xx' },
        body: Buffer.concat([
          Buffer.from(
            '--xx\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n',
          ),
          Buffer.alloc(bytes, 0x61),
          Buffer.from('\r\n--xx--\r\n'),
        ]),
      });
    expect((await send(1_000)).status).toBe(201);
    expect((await send(10 * 1024 * 1024 + 1)).status).toBe(413); // the api's own, structured answer
    const huge = await send(12 * 1024 * 1024);
    expect(huge.status).toBe(413); // nginx's early refusal
    expect((await request(front, { path: '/api/health' })).status).toBe(200);
  });
});
