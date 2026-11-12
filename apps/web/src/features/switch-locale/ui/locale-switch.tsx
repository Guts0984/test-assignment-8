'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { isLocale, LOCALE_COOKIE } from '@/shared/i18n/config';

const NAMES = { uk: 'Українська', en: 'English' } as const;

/** Native <select>: keyboard and screen-reader accessible for free. The choice lives in a cookie the server reads. */
export const LocaleSwitch = () => {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  return (
    <select
      aria-label={t('language')}
      value={locale}
      onChange={(e) => {
        if (!isLocale(e.target.value)) return;
        document.cookie = `${LOCALE_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {(Object.keys(NAMES) as Array<keyof typeof NAMES>).map((l) => (
        <option key={l} value={l} lang={l}>
          {NAMES[l]}
        </option>
      ))}
    </select>
  );
};
