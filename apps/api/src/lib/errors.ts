import { HttpException } from '@nestjs/common';
import type { ErrorCode, ErrorEnvelope } from '@helpdesk/shared';
import { ZodError } from 'zod';

const GENERIC_MESSAGE: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Request body too large',
  415: 'Unsupported content type or encoding',
  422: 'Unprocessable request',
  429: 'Too many requests',
  503: 'Service unavailable',
};

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_error',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/** Throwable application error → one consistent envelope (see ErrorEnvelope in shared). */
export const appError = (
  status: number,
  code: ErrorCode,
  message: string,
  extra: Partial<ErrorEnvelope['error']> = {},
): HttpException => new HttpException({ code, message, ...extra }, status);

export const tooManyRequests = (
  retryAfterSeconds: number,
  message = 'Too many requests',
): HttpException => appError(429, 'rate_limited', message, { retryAfterSeconds });

type PgLike = {
  code?: unknown;
  cause?: unknown;
  type?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
};

const findPgCode = (err: unknown): string | undefined => {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i += 1) {
    const code = (cur as PgLike).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as PgLike).cause;
  }
  return undefined;
};

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const isDbUnavailable = (err: unknown): boolean => {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i += 1) {
    const c = cur as PgLike;
    if (typeof c.code === 'string' && NETWORK_CODES.has(c.code)) return true;
    if (
      typeof c.message === 'string' &&
      /connection (terminated|timeout)|timeout exceeded when trying to connect|Connection terminated|the database system is|terminating connection/i.test(
        c.message,
      )
    )
      return true;
    cur = c.cause;
  }
  return false;
};

export type Mapped = {
  status: number;
  body: ErrorEnvelope['error'];
  headers?: Record<string, string>;
};

/** Maps ANY thrown value to an HTTP status + envelope. Bad input is always 4xx; unknown faults are 500 without details. */
export const mapError = (err: unknown, requestId: string | undefined): Mapped => {
  const base = (
    status: number,
    code: ErrorCode,
    message: string,
    extra: Partial<ErrorEnvelope['error']> = {},
  ): Mapped => ({
    status,
    body: { code, message, status, ...(requestId ? { requestId } : {}), ...extra },
    ...(extra.retryAfterSeconds
      ? { headers: { 'Retry-After': String(extra.retryAfterSeconds) } }
      : {}),
  });

  if (err instanceof ZodError) {
    return base(400, 'validation_error', 'Request validation failed', {
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const res = err.getResponse();
    const obj = typeof res === 'object' && res !== null ? (res as Record<string, unknown>) : {};
    const code =
      (typeof obj.code === 'string' ? (obj.code as ErrorCode) : undefined) ??
      CODE_BY_STATUS[status] ??
      (status >= 500 ? 'internal_error' : 'bad_request');
    // Messages written by our own code (they carry a `code`) are safe to show. Anything else — Nest's
    // built-ins, wrapped body-parser errors — can echo fragments of the request, so use a fixed text.
    const ours = typeof obj.code === 'string' && typeof obj.message === 'string';
    const message = ours
      ? String(obj.message)
      : (GENERIC_MESSAGE[status] ?? (status >= 500 ? 'Internal server error' : 'Bad request'));
    const extra: Partial<ErrorEnvelope['error']> = {};
    if (Array.isArray(obj.details))
      extra.details = obj.details as NonNullable<ErrorEnvelope['error']['details']>;
    if (obj.current !== undefined) extra.current = obj.current;
    if (typeof obj.retryAfterSeconds === 'number') extra.retryAfterSeconds = obj.retryAfterSeconds;
    return base(
      status,
      code,
      status >= 500 && code === 'internal_error' ? 'Internal server error' : message,
      extra,
    );
  }

  const pg = findPgCode(err);
  if (pg) {
    if (pg.startsWith('22')) return base(400, 'validation_error', 'Invalid value in request');
    if (pg === '23505') return base(409, 'conflict', 'Resource already exists');
    if (pg === '23503')
      return base(409, 'conflict', 'Referenced resource does not exist or is in use');
    if (pg.startsWith('23'))
      return base(400, 'validation_error', 'Request violates a data constraint');
    if (pg === '57014' || pg === '40001' || pg === '40P01')
      return base(503, 'service_unavailable', 'Database is busy, retry shortly', {
        retryAfterSeconds: 1,
      });
    if (/^(08|53|57P|3D)/.test(pg))
      return base(503, 'service_unavailable', 'Database unavailable', { retryAfterSeconds: 2 });
  }
  if (isDbUnavailable(err))
    return base(503, 'service_unavailable', 'Database unavailable', { retryAfterSeconds: 2 });

  // body-parser / http-errors style errors carry a 4xx status
  const e = (err ?? {}) as PgLike;
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    return base(
      status,
      CODE_BY_STATUS[status] ?? 'bad_request',
      status === 413
        ? 'Request body too large'
        : status === 415
          ? 'Unsupported content type or encoding'
          : 'Bad request',
    );
  }
  return base(500, 'internal_error', 'Internal server error');
};
