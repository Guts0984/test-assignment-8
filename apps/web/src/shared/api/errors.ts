import { errorEnvelopeSchema, type ErrorCode } from '@helpdesk/shared';

export type ApiErrorInfo = {
  status: number;
  code: ErrorCode | 'network_error';
  message: string;
  requestId?: string;
  details?: Array<{ path: string; message: string }>;
  /** 409 version conflict: the server's current state of the resource. */
  current?: unknown;
  retryAfterSeconds?: number;
};

export type ApiError = Error & { readonly name: 'ApiError'; readonly info: ApiErrorInfo };

export const makeApiError = (info: ApiErrorInfo): ApiError =>
  Object.assign(new Error(info.message), { name: 'ApiError' as const, info });
export const isApiError = (e: unknown): e is ApiError =>
  e instanceof Error && e.name === 'ApiError' && 'info' in e;

/** Turns any response body into ApiErrorInfo: the standard envelope when present, a generic one otherwise (proxy errors, HTML pages). */
export const parseErrorBody = (
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): ApiErrorInfo => {
  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    const header = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    return {
      status,
      code: e.code,
      message: e.message,
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.details ? { details: e.details } : {}),
      ...(e.current !== undefined ? { current: e.current } : {}),
      ...((e.retryAfterSeconds ?? (Number.isFinite(header) ? header : undefined)) !== undefined
        ? { retryAfterSeconds: e.retryAfterSeconds ?? (header as number) }
        : {}),
    };
  }
  return {
    status,
    code:
      status >= 500 ? (status === 503 ? 'service_unavailable' : 'internal_error') : 'bad_request',
    message: `HTTP ${status}`,
  };
};
