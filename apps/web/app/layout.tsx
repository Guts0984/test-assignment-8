import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { Providers } from '@/app/providers';
import { SkipLink } from '@/shared/ui/skip-link';
import '@/app/styles.css';

export const metadata: Metadata = {
  title: { default: 'Helpdesk', template: '%s · Helpdesk' },
  robots: { index: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, messages, t] = await Promise.all([
    getLocale(),
    getMessages(),
    getTranslations('common'),
  ]);
  return (
    // suppressHydrationWarning: next-themes sets the `class` on <html> before React hydrates
    <html lang={locale} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
          <SkipLink label={t('skipToContent')} />
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
