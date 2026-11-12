export const LOCALES = ['uk', 'en'] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = 'uk';
export const LOCALE_COOKIE = 'locale';

export const isLocale = (v: unknown): v is AppLocale =>
  typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
export const toLocale = (v: unknown): AppLocale => (isLocale(v) ? v : DEFAULT_LOCALE);
