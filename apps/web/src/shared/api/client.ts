import { isApiError, makeApiError, parseErrorBody } from './errors';

export type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | boolean | readonly string[] | null | undefined>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export type ApiClient = {
  request: <T>(method: string, path: string, options?: RequestOptions) => Promise<T>;
  get: <T>(path: string, options?: RequestOptions) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  put: <T>(path: string, body?: unknown, options?: RequestOptions) => Promise<T>;
  delete: <T>(path: string, options?: RequestOptions) => Promise<T>;
  baseUrl: string;
};

const queryString = (q: RequestOptions['query']): string => {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(','));
    } else params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
};

/**
 * Typed fetch wrapper. Cookies travel with every call (the session is an httpOnly cookie). Every failure —
 * HTTP error, proxy HTML page, dropped connection — becomes an ApiError with a code the UI can translate.
 */
export const createApiClient = (opts: { baseUrl: string; fetchImpl?: typeof fetch }): ApiClient => {
  const doFetch = (...args: Parameters<typeof fetch>) => (opts.fetchImpl ?? fetch)(...args);

  const request = async <T>(method: string, path: string, o: RequestOptions = {}): Promise<T> => {
    const hasBody = o.body !== undefined;
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}${queryString(o.query)}`, {
        method,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...(o.headers ?? {}),
        },
        ...(hasBody ? { body: JSON.stringify(o.body) } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err; // cancellation is not a failure to report (name check: DOMException classes differ across realms)
      throw makeApiError({ status: 0, code: 'network_error', message: 'Network error' });
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // a proxy's HTML error page, say
    }
    if (!res.ok)
      throw makeApiError(parseErrorBody(res.status, json, res.headers.get('retry-after')));
    return json as T;
  };

  return {
    baseUrl: opts.baseUrl,
    request,
    get: (path, o) => request('GET', path, o),
    post: (path, body, o) =>
      request('POST', path, { ...o, ...(body !== undefined ? { body } : {}) }),
    patch: (path, body, o) =>
      request('PATCH', path, { ...o, ...(body !== undefined ? { body } : {}) }),
    put: (path, body, o) => request('PUT', path, { ...o, ...(body !== undefined ? { body } : {}) }),
    delete: (path, o) => request('DELETE', path, o),
  };
};

/** The app-wide client: relative `/api`, proxied to the NestJS api by Next (same origin). */
export const api = createApiClient({ baseUrl: process.env.NEXT_PUBLIC_API_BASE ?? '/api' });
export { isApiError };
