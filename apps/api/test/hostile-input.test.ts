import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import {
  createUsers,
  rawRequest,
  request,
  startApi,
  statusOfRaw,
  type Api,
  type Res,
} from './harness';

/** Nothing the server says may reveal how it works inside. */
const LEAKS =
  /node_modules|\/home\/|\.ts:\d|\bat \w+.*\(|SELECT |INSERT |drizzle|pg_catalog|ECONN|stack|postgres:\/\//i;
const expectClean = (r: Res | string) => {
  const text = typeof r === 'string' ? r : r.text;
  expect(text, 'response leaks internals').not.toMatch(LEAKS);
};

describe('hostile input against the real server → always 4xx, never 5xx, never a leak', () => {
  let t: TestDb;
  let api: Api;
  beforeAll(async () => {
    t = await createTestDb();
    await createUsers(t.db);
    api = await startApi(t.url, { RATE_LIMIT_API_PER_MIN: '100000' });
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });

  const post = (body: string | Buffer | object | undefined, headers: Record<string, string> = {}) =>
    request(api, { method: 'POST', path: '/auth/login', body, headers });

  describe('basic contract', () => {
    it('/health and /ready answer', async () => {
      expect((await request(api, { path: '/health' })).json).toEqual({ status: 'ok' });
      expect((await request(api, { path: '/ready' })).json).toEqual({ status: 'ready' });
    });
    it('unknown route → 404 in the standard envelope; every error has a request id', async () => {
      const r = await request(api, { path: '/definitely/not/here' });
      expect(r.status).toBe(404);
      expect(r.json).toMatchObject({ error: { code: 'not_found', status: 404 } });
      expect((r.json as { error: { requestId: string } }).error.requestId).toBe(
        r.headers['x-request-id'],
      );
    });
    it('security headers on every response, no X-Powered-By', async () => {
      const r = await request(api, { path: '/me' });
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['x-frame-options']).toBe('DENY');
    });
    it('Swagger is served and does not expose secrets', async () => {
      expect((await request(api, { path: '/docs' })).status).toBe(200);
      const doc = await request(api, { path: '/docs-json' });
      expect(doc.status).toBe(200);
      expect(doc.text).toContain('/auth/login');
      expect(doc.text).not.toMatch(/postgres:\/\/|helpdesk_dev_password|DATABASE_URL/);
    });
    it('an incoming X-Request-Id is kept only if it looks sane', async () => {
      expect(
        (await request(api, { path: '/health', headers: { 'x-request-id': 'abc-12345678' } }))
          .headers['x-request-id'],
      ).toBe('abc-12345678');
      const bad = await request(api, {
        path: '/health',
        headers: { 'x-request-id': '<script>alert(1)</script>' },
      });
      expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('malformed bodies', () => {
    const cases: Array<[string, () => Promise<Res>, number | number[]]> = [
      ['broken JSON', () => post('{bad'), 400],
      ['truncated JSON', () => post('{"email":"a@b.c","passw'), 400],
      [
        'empty body with json content-type',
        () => post('', { 'content-type': 'application/json' }),
        400,
      ],
      ['JSON null', () => post('null', { 'content-type': 'application/json' }), 400],
      ['JSON array', () => post('[]', { 'content-type': 'application/json' }), 400],
      ['JSON string', () => post('"hello"', { 'content-type': 'application/json' }), 400],
      ['bare number (strict mode)', () => post('42', { 'content-type': 'application/json' }), 400],
      [
        'text/plain with valid JSON (what a cross-site <form> can send)',
        () =>
          post('{"email":"agent@t.test","password":"Agent#test1"}', {
            'content-type': 'text/plain',
          }),
        400,
      ],
      [
        'form-encoded body',
        () =>
          post('email=agent@t.test&password=x', {
            'content-type': 'application/x-www-form-urlencoded',
          }),
        400,
      ],
      [
        'multipart to a JSON route',
        () => post('--x\r\n\r\n--x--', { 'content-type': 'multipart/form-data; boundary=x' }),
        400,
      ],
      [
        'no content-type at all',
        () => post('{"email":"a@b.c","password":"x"}', { 'content-type': '' }),
        400,
      ],
      [
        '100 000-level deep nesting',
        () =>
          post('['.repeat(100_000) + ']'.repeat(100_000), { 'content-type': 'application/json' }),
        400,
      ],
      [
        'deeply nested object (20 000 levels, under the size limit)',
        () =>
          post('{"a":'.repeat(20_000) + '1' + '}'.repeat(20_000), {
            'content-type': 'application/json',
          }),
        400,
      ],
      [
        'deeply nested object over the size limit',
        () =>
          post('{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000), {
            'content-type': 'application/json',
          }),
        413,
      ],
      ['NUL byte inside a string', () => post({ email: 'a\u0000@b.c', password: 'x' }), 400],
      [
        'lone surrogate / invalid unicode escape',
        () => post('{"email":"\\ud800","password":"x"}', { 'content-type': 'application/json' }),
        [400, 401],
      ],
      [
        'invalid UTF-8 bytes',
        () =>
          post(Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]), {
            'content-type': 'application/json',
          }),
        400,
      ],
      [
        'utf-16 body that is not valid JSON once decoded',
        () => post('{}', { 'content-type': 'application/json; charset=utf-16' }),
        400,
      ],
      [
        'unsupported charset',
        () => post('{}', { 'content-type': 'application/json; charset=windows-1251' }),
        415,
      ],
      [
        'unknown content-encoding',
        () =>
          post('{}', { 'content-type': 'application/json', 'content-encoding': 'compress-ish' }),
        415,
      ],
      [
        'gzip header with garbage body',
        () =>
          post(Buffer.from('this is not gzip'), {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          }),
        400,
      ],
      [
        'body bigger than the limit (300 KB)',
        () =>
          post('{"email":"' + 'a'.repeat(300_000) + '"}', { 'content-type': 'application/json' }),
        413,
      ],
      [
        'zip bomb: 60 MB of zeros gzipped to ~60 KB',
        () =>
          post(gzipSync(Buffer.alloc(60 * 1024 * 1024, 0x20)), {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
          }),
        413,
      ],
      [
        'prototype pollution via __proto__',
        () =>
          post('{"__proto__":{"isAdmin":true},"email":"agent@t.test","password":"Agent#test1"}', {
            'content-type': 'application/json',
          }),
        400,
      ],
      [
        'constructor.prototype pollution',
        () =>
          post(
            '{"constructor":{"prototype":{"x":1}},"email":"agent@t.test","password":"Agent#test1"}',
            { 'content-type': 'application/json' },
          ),
        400,
      ],
      [
        'mass assignment of role',
        () => post({ email: 'agent@t.test', password: 'Agent#test1', role: 'lead' }),
        400,
      ],
      [
        'email as object (NoSQL-style operator)',
        () => post({ email: { $ne: null }, password: 'x' }),
        400,
      ],
      ['email as array', () => post({ email: ['agent@t.test'], password: 'x' }), 400],
      ['password as number', () => post({ email: 'agent@t.test', password: 12345 }), 400],
      [
        'password 129 chars (hash-DoS guard)',
        () => post({ email: 'agent@t.test', password: 'x'.repeat(129) }),
        400,
      ],
      [
        'password 5 MB',
        () => post({ email: 'agent@t.test', password: 'x'.repeat(5_000_000) }),
        413,
      ],
      ['homoglyph email (Cyrillic а)', () => post({ email: 'аgent@t.test', password: 'x' }), 400],
      ['SQL injection in email', () => post({ email: "' OR 1=1 --@x.test", password: 'x' }), 400],
      [
        'SQL injection in password',
        () => post({ email: 'agent@t.test', password: "' OR '1'='1" }),
        401,
      ],
    ];
    it.each(cases)('%s', async (_name, run, expected) => {
      const r = await run();
      expect([expected].flat(), `got ${r.status}: ${r.text.slice(0, 200)}`).toContain(r.status);
      expect(r.status).toBeLessThan(500);
      if (r.text)
        expect(r.json, 'errors must be JSON envelopes').toMatchObject({
          error: { status: r.status },
        });
      expectClean(r);
    });

    it('after the whole battery the server is healthy and prototypes are untouched', async () => {
      expect((await request(api, { path: '/ready' })).status).toBe(200);
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      const ok = await post({ email: 'agent@t.test', password: 'Agent#test1' });
      expect(ok.status).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'isAdmin')).toBe(false);
    });
  });

  describe('malformed requests (raw TCP)', () => {
    const base = (line: string, extra = '') =>
      `${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${extra}\r\n`;
    const cases: Array<[string, string]> = [
      ['bad percent-encoding in path', base('GET /%zz')],
      ['encoded NUL in path', base('GET /%00')],
      ['overlong UTF-8 in path', base('GET /%c0%af')],
      ['path traversal', base('GET /../../../../etc/passwd')],
      ['encoded path traversal', base('GET /%2e%2e/%2e%2e/etc/passwd')],
      ['query with NUL and bad encoding', base('GET /me?q=%00%zz&__proto__[x]=1')],
      ['20 KB URL', base(`GET /${'a'.repeat(20_000)}`)],
      ['20 KB header value', base('GET /health', `X-Big: ${'a'.repeat(20_000)}\r\n`)],
      [
        '300 headers',
        base('GET /health', Array.from({ length: 300 }, (_, i) => `X-H${i}: v\r\n`).join('')),
      ],
      ['20 KB cookie', base('GET /me', `Cookie: hd_session=${'a'.repeat(20_000)}\r\n`)],
      ['TRACE', base('TRACE /health')],
      ['made-up method', base('BREW /health')],
      [
        'negative content-length',
        base('POST /auth/login', 'Content-Type: application/json\r\nContent-Length: -5\r\n'),
      ],
      [
        'non-numeric content-length',
        base('POST /auth/login', 'Content-Type: application/json\r\nContent-Length: abc\r\n'),
      ],
      [
        'two content-lengths (request smuggling)',
        base('POST /auth/login', 'Content-Length: 2\r\nContent-Length: 5\r\n') + '{}',
      ],
      [
        'content-length + transfer-encoding (smuggling)',
        base('POST /auth/login', 'Content-Length: 4\r\nTransfer-Encoding: chunked\r\n') +
          '0\r\n\r\n',
      ],
      [
        'invalid chunk size',
        base(
          'POST /auth/login',
          'Transfer-Encoding: chunked\r\nContent-Type: application/json\r\n',
        ) + 'zzzz\r\n{}\r\n0\r\n\r\n',
      ],
      ['HTTP/0.9 style', 'GET /health\r\n\r\n'],
      ['garbage bytes', '\x00\x01\x02\xff\xfe garbage\r\n\r\n'],
      ['missing Host (HTTP/1.1)', 'GET /health HTTP/1.1\r\nConnection: close\r\n\r\n'],
      ['header name with space', base('GET /health', 'Bad Header: x\r\n')],
      ['lone LF line endings', 'GET /health HTTP/1.1\nHost: x\nConnection: close\n\n'],
    ];
    it.each(cases)('%s', async (_name, bytes) => {
      const res = await rawRequest(api.port, bytes);
      const status = statusOfRaw(res);
      // 0 = the server just closed the socket, which is also a fine answer to garbage
      expect(status === 0 || (status >= 200 && status < 500), `got: ${res.slice(0, 200)}`).toBe(
        true,
      );
      expectClean(res);
    });

    it('CRLF injected through a header cannot add response headers or forge cookies', async () => {
      const res = await rawRequest(
        api.port,
        base('GET /health', 'X-Request-Id: abc\r\nSet-Cookie: pwn=1\r\nX-Evil: 1\r\n'),
      );
      expect(statusOfRaw(res)).toBe(200);
      expect(res.toLowerCase()).not.toContain('pwn=1');
      expect(res.toLowerCase()).not.toContain('x-evil');
    });

    it('the server is still healthy after all of it', async () => {
      expect((await request(api, { path: '/ready' })).status).toBe(200);
    });
  });

  describe('query-string abuse', () => {
    it.each([
      '/me?a[]=1&a=2&a[b]=3',
      '/me?__proto__[x]=1&constructor[prototype][y]=2',
      `/me?${'a=1&'.repeat(5_000)}`,
      '/me?%00=%00',
      '/me?x=%E0%A4%A',
    ])('%s', async (p) => {
      const r = await request(api, { path: p });
      expect(r.status).toBeLessThan(500);
      expectClean(r);
    });
  });

  describe('every route requires authentication unless explicitly public (deny by default)', () => {
    const PUBLIC = new Set(['GET /health', 'GET /ready', 'POST /auth/login', 'POST /auth/logout']);
    it('walks the OpenAPI document and hits each route anonymously', async () => {
      const doc = (await request(api, { path: '/docs-json' })).json as {
        paths: Record<string, Record<string, unknown>>;
      };
      const checked: string[] = [];
      for (const [p, methods] of Object.entries(doc.paths)) {
        for (const method of Object.keys(methods)) {
          const key = `${method.toUpperCase()} ${p}`;
          const concrete = p.replace(/\{[^}]+\}/g, crypto.randomUUID());
          const r = await request(api, {
            method: method.toUpperCase(),
            path: concrete,
            body: ['post', 'put', 'patch'].includes(method) ? {} : undefined,
          });
          if (PUBLIC.has(key)) expect(r.status, key).not.toBe(401);
          else expect(r.status, `${key} must reject anonymous callers`).toBe(401);
          checked.push(key);
        }
      }
      expect(checked.length).toBeGreaterThanOrEqual(5);
    });
  });
});
