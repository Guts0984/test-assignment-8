import type { ApiErrorInfo } from '@/shared/api/errors';

type T = (key: string, values?: Record<string, string | number>) => string;

/**
 * Maps an API/network failure to a localised sentence. `t` is `useTranslations('errors')`.
 * `unauthenticated` means "wrong credentials" on the login form; elsewhere a 401 triggers the sign-in redirect instead.
 */
export const describeError = (
  t: T,
  info: ApiErrorInfo,
  opts: { unauthenticated?: 'invalidCredentials' | 'unknown' } = {},
): string => {
  switch (info.code) {
    case 'unauthenticated':
      return t(opts.unauthenticated ?? 'unknown');
    case 'rate_limited':
      return t('tooManyAttempts', { seconds: info.retryAfterSeconds ?? 1 });
    case 'network_error':
      return t('network');
    case 'service_unavailable':
      return t('unavailable');
    case 'forbidden':
      return t('forbidden');
    case 'not_found':
      return t('notFound');
    case 'conflict':
    case 'version_conflict':
      return t('conflict');
    case 'internal_error':
      return t('server');
    default:
      return info.status >= 500 ? t('server') : t('unknown');
  }
};
