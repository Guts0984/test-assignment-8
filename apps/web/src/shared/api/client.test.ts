import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API, envelope, http, HttpResponse, server } from '../../../test/utils';
import { createApiClient } from './client';
import { isApiError } from './errors';

const client = createApiClient({ baseUrl: API });
const catchError = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('api client', () => {
  it('returns parsed JSON and sends credentials + JSON content type', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spy = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    expect(
      await createApiClient({ baseUrl: API, fetchImpl: spy }).post('/things', { a: 1 }),
    ).toEqual({ ok: true });
    expect(calls[0]?.init.credentials).toBe('include'); // the httpOnly session cookie travels with every call
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ a: 1 });
  });

  it('serialises query params: arrays as CSV, skips empty / undefined / null', async () => {
    let url = '';
    server.use(
      http.get(`${API}/tickets`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({});
      }),
    );
    await client.get('/tickets', {
      query: {
        status: ['open', 'pending'],
        q: 'a b&c',
        page: 2,
        empty: '',
        no: undefined,
        nil: null,
        none: [],
        yes: true,
      },
    });
    const u = new URL(url);
    expect(u.searchParams.get('status')).toBe('open,pending');
    expect(u.searchParams.get('q')).toBe('a b&c');
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('yes')).toBe('true');
    for (const k of ['empty', 'no', 'nil', 'none']) expect(u.searchParams.has(k)).toBe(false);
  });

  it('204 → undefined', async () => {
    server.use(http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })));
    expect(await client.post('/auth/logout')).toBeUndefined();
  });

  it('maps the standard error envelope to an ApiError with code, status and request id', async () => {
    server.use(
      http.get(`${API}/me`, () => envelope(401, 'unauthenticated', 'Authentication required')),
    );
    const e = await catchError(client.get('/me'));
    expect(isApiError(e)).toBe(true);
    expect((e as { info: unknown }).info).toMatchObject({
      status: 401,
      code: 'unauthenticated',
      requestId: 'req-1',
    });
  });

  it('keeps retry-after (body, or header as a fallback) for 429', async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        envelope(429, 'rate_limited', 'slow', { retryAfterSeconds: 42 }),
      ),
    );
    expect(
      (
        (await catchError(client.post('/auth/login', {}))) as {
          info: { retryAfterSeconds: number };
        }
      ).info.retryAfterSeconds,
    ).toBe(42);
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          { error: { code: 'rate_limited', message: 'm', status: 429 } },
          { status: 429, headers: { 'retry-after': '7' } },
        ),
      ),
    );
    expect(
      (
        (await catchError(client.post('/auth/login', {}))) as {
          info: { retryAfterSeconds: number };
        }
      ).info.retryAfterSeconds,
    ).toBe(7);
  });

  it("keeps the CURRENT state of a 409 version conflict (the UI shows it without losing the user's input)", async () => {
    server.use(
      http.patch(`${API}/tickets/1`, () =>
        envelope(409, 'version_conflict', 'changed', { current: { version: 5, status: 'open' } }),
      ),
    );
    const e = (await catchError(client.patch('/tickets/1', { version: 1 }))) as {
      info: { code: string; current: unknown };
    };
    expect(e.info).toMatchObject({
      code: 'version_conflict',
      current: { version: 5, status: 'open' },
    });
  });

  it('keeps per-field validation details', async () => {
    server.use(
      http.post(`${API}/tickets`, () =>
        envelope(400, 'validation_error', 'bad', {
          details: [{ path: 'subject', message: 'too long' }],
        }),
      ),
    );
    expect(
      ((await catchError(client.post('/tickets', {}))) as { info: { details: unknown } }).info
        .details,
    ).toEqual([{ path: 'subject', message: 'too long' }]);
  });

  it.each([
    [
      'an HTML error page from a proxy (502)',
      () =>
        new HttpResponse('<html>Bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      502,
      'internal_error',
    ],
    [
      '503 without a body',
      () => new HttpResponse(null, { status: 503 }),
      503,
      'service_unavailable',
    ],
    [
      '404 with garbage JSON',
      () => HttpResponse.json({ hello: 'world' }, { status: 404 }),
      404,
      'bad_request',
    ],
    [
      '200 with a broken JSON body is returned as null, not thrown',
      () => new HttpResponse('{oops', { status: 200 }),
      200,
      null,
    ],
  ] as const)('%s', async (_n, respond, status, code) => {
    server.use(http.get(`${API}/x`, respond));
    if (code === null) return expect(await client.get('/x')).toBeNull();
    const e = (await catchError(client.get('/x'))) as { info: { status: number; code: string } };
    expect(e.info).toMatchObject({ status, code });
  });

  it('a dropped connection is a network_error, not an exception the UI cannot describe', async () => {
    server.use(http.get(`${API}/x`, () => HttpResponse.error()));
    expect(
      ((await catchError(client.get('/x'))) as { info: { code: string; status: number } }).info,
    ).toMatchObject({ code: 'network_error', status: 0 });
  });

  it('cancellation (AbortSignal) is NOT turned into an ApiError', async () => {
    server.use(
      http.get(`${API}/slow`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({});
      }),
    );
    const ctl = new AbortController();
    const p = client.get('/slow', { signal: ctl.signal });
    ctl.abort();
    const e = await catchError(p);
    expect(isApiError(e)).toBe(false);
    expect((e as Error).name).toBe('AbortError');
  });
});
