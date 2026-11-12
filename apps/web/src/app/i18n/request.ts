import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, toLocale } from '@/shared/i18n/config';

/** Locale = the `locale` cookie (default Ukrainian). Messages are bundled; dates are formatted in the browser's own time zone. */
export default getRequestConfig(async () => {
  const locale = toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return {
    locale,
    messages: (await import(`../../shared/i18n/messages/${locale}.json`)).default,
    timeZone: 'UTC', // only a fallback; every visible date passes the viewer's zone explicitly (see useLocalFormat)
  };
});
