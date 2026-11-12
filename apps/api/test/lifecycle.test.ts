import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { createUsers, login, PASSWORDS, request, sessionCookie, startApi } from './harness';

describe('process lifecycle and failure handling (real server)', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
  });
  const boot = async (env: Record<string, string> = {}) => {
    const t: TestDb = await createTestDb();
    cleanup.push(() => t.drop());
    const users = await createUsers(t.db);
    const api = await startApi(t.url, { RATE_LIMIT_API_PER_MIN: '100000', ...env });
    cleanup.push(() => api.stop('SIGKILL'));
    return { t, api, users };
  };

  describe('graceful shutdown on SIGTERM', () => {
    it('an in-flight request is finished, then the process exits with code 0', async () => {
      const { api } = await boot({ SHUTDOWN_TIMEOUT_MS: '8000' });
      // start a request and leave its body half-sent: it is "in flight" on the server
      const sock = net.connect({ host: '127.0.0.1', port: api.port });
      let response = '';
      sock.on('data', (d) => (response += d.toString()));
      await new Promise<void>((r) => sock.on('connect', () => r()));
      const body = '{"email":"agent@t.test","password":"wrong-password"}';
      sock.write(
        `POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, 10)}`,
      );
      await new Promise((r) => setTimeout(r, 200));

      const exited = api.stop('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      let exitedYet = false;
      void api.exited.then(() => (exitedYet = true));
      expect(exitedYet, 'must NOT exit while a request is still being served').toBe(false);

      sock.write(body.slice(10)); // the client finishes its request
      const code = await exited;
      expect(response).toMatch(/^HTTP\/1\.1 401/); // it was served (wrong password → 401), not dropped
      expect(code).toBe(0);
    });

    it('while draining: readiness flips to 503 and responses ask clients to close the connection', async () => {
      const { api } = await boot({ SHUTDOWN_TIMEOUT_MS: '8000' });
      const sock = net.connect({ host: '127.0.0.1', port: api.port });
      await new Promise<void>((r) => sock.on('connect', () => r()));
      sock.write(
        'POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{',
      );
      await new Promise((r) => setTimeout(r, 150));
      const exited = api.stop('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      // a NEW connection is refused (listener closed) — exactly what a load balancer needs
      const refused = await request(api, { path: '/ready', timeoutMs: 2000 }).then(
        () => false,
        () => true,
      );
      expect(refused).toBe(true);
      sock.destroy();
      expect(await exited).toBe(0);
    });

    it('an idle server exits 0 promptly on SIGTERM and on SIGINT', async () => {
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        const { api } = await boot();
        const started = Date.now();
        expect(await api.stop(sig)).toBe(0);
        expect(Date.now() - started).toBeLessThan(3_000);
      }
    });

    it('idle keep-alive connections do not hold shutdown hostage', async () => {
      const { api } = await boot({ KEEP_ALIVE_TIMEOUT_MS: '60000' });
      const socks = await Promise.all(
        Array.from(
          { length: 20 },
          () =>
            new Promise<net.Socket>((res) => {
              const s = net.connect({ host: '127.0.0.1', port: api.port }, () => res(s));
              s.on('error', () => undefined);
              s.resume();
            }),
        ),
      );
      for (const s of socks) s.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n'); // keep-alive, now idle
      await new Promise((r) => setTimeout(r, 300));
      const started = Date.now();
      expect(await api.stop('SIGTERM')).toBe(0);
      expect(Date.now() - started).toBeLessThan(3_000);
      socks.forEach((s) => s.destroy());
    });
  });

  describe('database failure', () => {
    it('losing the database: /ready → 503, DB-backed routes → 503 envelope (not 500, not a hang), /health stays 200, process survives', async () => {
      const { t, api, users } = await boot({ DB_CONNECT_TIMEOUT_MS: '1500' });
      const ok = await login(api, users.agent.email, PASSWORDS.agent);
      const cookie = sessionCookie(ok)!;
      expect((await request(api, { path: '/ready' })).status).toBe(200);

      await t.drop(); // DROP DATABASE … WITH (FORCE): connections are terminated, the database is gone
      cleanup.length = 0;
      cleanup.push(() => api.stop('SIGKILL'));

      const ready = await request(api, { path: '/ready' });
      expect(ready.status).toBe(503);
      expect(ready.json).toMatchObject({ error: { code: 'service_unavailable' } });
      const me = await request(api, { path: '/me', cookie });
      expect(me.status).toBe(503);
      expect(me.json).toMatchObject({ error: { code: 'service_unavailable' } });
      expect(me.text).not.toMatch(/database "|hd_test|FATAL|pg_|ECONN/);
      const lg = await login(api, users.agent.email, PASSWORDS.agent);
      expect(lg.status).toBe(503);
      expect(me.headers['retry-after']).toBeDefined();
      expect((await request(api, { path: '/health' })).status).toBe(200);
      expect(
        await Promise.race([api.exited, new Promise((r) => setTimeout(() => r('alive'), 500))]),
      ).toBe('alive');
    });

    it('a burst of 60 requests during the outage all fail fast with 503', async () => {
      const { t, api } = await boot({ DB_CONNECT_TIMEOUT_MS: '1000' });
      await t.drop();
      cleanup.length = 0;
      cleanup.push(() => api.stop('SIGKILL'));
      const started = Date.now();
      const rs = await Promise.all(Array.from({ length: 60 }, () => request(api, { path: '/me' })));
      expect(rs.every((r) => r.status === 503)).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  describe('startup validation', () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['dist/main.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
        timeout: 15_000,
      });

    it('without DATABASE_URL the process refuses to start and says which variable is missing', () => {
      const r = run({});
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/DATABASE_URL/);
    });
    it('a bad value is reported by name and its content is never printed', () => {
      const r = run({
        DATABASE_URL: 'postgres://u:topsecretpassword@localhost:1/x',
        PORT: 'topsecretpassword',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/PORT/);
      expect(r.stderr).not.toContain('topsecretpassword');
    });
    it('an invalid TRUSTED_PROXIES entry stops startup (a typo must not silently disable proxy handling)', async () => {
      const t = await createTestDb();
      cleanup.push(() => t.drop());
      const r = run({ DATABASE_URL: t.url, TRUSTED_PROXIES: 'not-an-ip', AUTO_MIGRATE: 'false' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/TRUSTED_PROXIES/);
    });
    it('an unreachable database makes startup fail (non-zero exit) instead of hanging forever', () => {
      const r = run({
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/nope',
        DB_CONNECT_TIMEOUT_MS: '1000',
        AUTO_MIGRATE: 'true',
      });
      expect(r.status).toBe(1);
    });
  });
});
