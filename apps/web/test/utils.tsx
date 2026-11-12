import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { vi } from 'vitest';
import en from '@/shared/i18n/messages/en.json';
import uk from '@/shared/i18n/messages/uk.json';
import type { AppLocale } from '@/shared/i18n/config';
import { AnnouncerProvider } from '@/shared/ui/announcer';

export const MESSAGES = { uk, en } as const;
export const API = 'http://localhost:3000/api';

export const router = {
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
};

export const makeClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });

export const Wrapper = ({
  children,
  locale = 'uk',
  client,
}: {
  children: ReactNode;
  locale?: AppLocale;
  client?: QueryClient;
}) => (
  <QueryClientProvider client={client ?? makeClient()}>
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <AnnouncerProvider>{children}</AnnouncerProvider>
    </NextIntlClientProvider>
  </QueryClientProvider>
);

export const renderApp = (
  ui: ReactElement,
  opts: { locale?: AppLocale; client?: QueryClient } & Omit<RenderOptions, 'wrapper'> = {},
) => {
  const { locale, client, ...rest } = opts;
  return render(ui, {
    wrapper: ({ children }) => (
      <Wrapper {...(locale ? { locale } : {})} {...(client ? { client } : {})}>
        {children}
      </Wrapper>
    ),
    ...rest,
  });
};

export const server = setupServer();
export const envelope = (
  status: number,
  code: string,
  message = 'x',
  extra: Record<string, unknown> = {},
) =>
  HttpResponse.json({ error: { code, message, status, requestId: 'req-1', ...extra } }, { status });
export { http, HttpResponse };

export const ME = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'agent@x.test',
  name: 'Іван Мельник',
  role: 'agent',
  categories: ['payment'],
  locale: 'uk',
} as const;
export const CUSTOMER = {
  ...ME,
  id: '22222222-2222-4222-8222-222222222222',
  email: 'c@x.test',
  name: 'Олена',
  role: 'customer',
  categories: [],
} as const;
