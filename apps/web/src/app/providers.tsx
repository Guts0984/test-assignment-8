'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { isApiError } from '@/shared/api/client';
import { AnnouncerProvider } from '@/shared/ui/announcer';

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // retrying a 4xx never helps; transient failures get a couple of tries
        retry: (count, error) =>
          isApiError(error) && error.info.status >= 400 && error.info.status < 500
            ? false
            : count < 2,
      },
      mutations: { retry: false },
    },
  });

export const Providers = ({ children }: { children: ReactNode }) => {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <AnnouncerProvider>{children}</AnnouncerProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};
