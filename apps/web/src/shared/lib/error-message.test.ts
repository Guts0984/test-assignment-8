import { describe, expect, it } from 'vitest';
import en from '@/shared/i18n/messages/en.json';
import { describeError } from './error-message';
import type { ApiErrorInfo } from '@/shared/api/errors';

const t = (key: string, v: Record<string, string | number> = {}) =>
  `${key}${v.seconds !== undefined ? `:${v.seconds}` : ''}`;
const info = (over: Partial<ApiErrorInfo>): ApiErrorInfo => ({
  status: 400,
  code: 'bad_request',
  message: 'm',
  ...over,
});

describe('describeError', () => {
  it.each([
    [{ code: 'rate_limited', status: 429, retryAfterSeconds: 9 }, 'tooManyAttempts:9'],
    [{ code: 'rate_limited', status: 429 }, 'tooManyAttempts:1'],
    [{ code: 'network_error', status: 0 }, 'network'],
    [{ code: 'service_unavailable', status: 503 }, 'unavailable'],
    [{ code: 'forbidden', status: 403 }, 'forbidden'],
    [{ code: 'not_found', status: 404 }, 'notFound'],
    [{ code: 'version_conflict', status: 409 }, 'conflict'],
    [{ code: 'conflict', status: 409 }, 'conflict'],
    [{ code: 'internal_error', status: 500 }, 'server'],
    [{ code: 'bad_request', status: 502 }, 'server'],
    [{ code: 'bad_request', status: 418 }, 'unknown'],
  ] as const)('%j → %s', (i, expected) => expect(describeError(t, info(i))).toBe(expected));
  it('401 is "wrong credentials" only where the caller says so', () => {
    expect(
      describeError(t, info({ code: 'unauthenticated', status: 401 }), {
        unauthenticated: 'invalidCredentials',
      }),
    ).toBe('invalidCredentials');
    expect(describeError(t, info({ code: 'unauthenticated', status: 401 }))).toBe('unknown');
  });
  it('every key it can return exists in the catalogue', () => {
    const keys = [
      'tooManyAttempts',
      'network',
      'unavailable',
      'forbidden',
      'notFound',
      'conflict',
      'server',
      'unknown',
      'invalidCredentials',
    ];
    for (const k of keys) expect((en.errors as Record<string, string>)[k], k).toBeTruthy();
  });
});
