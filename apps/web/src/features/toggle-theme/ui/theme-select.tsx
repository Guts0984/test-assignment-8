'use client';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useIsClient } from '@/shared/lib/format';

/** Light / dark / follow the system. Rendered only on the client: the stored theme is unknown on the server. */
export const ThemeSelect = () => {
  const t = useTranslations('common');
  const { theme, setTheme } = useTheme();
  const client = useIsClient();
  return (
    <select
      aria-label={t('theme')}
      value={client ? (theme ?? 'system') : 'system'}
      onChange={(e) => setTheme(e.target.value)}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <option value="system">{t('themeSystem')}</option>
      <option value="light">{t('themeLight')}</option>
      <option value="dark">{t('themeDark')}</option>
    </select>
  );
};
