'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import {
  parseFilters,
  serializeFilters,
  type TicketFilters,
} from '@/entities/ticket/model/filters';

/**
 * The queue's filters live in the URL: a reload restores them, Back/Forward walk through them, links can be shared.
 * Discrete changes push a history entry; typing in the search box replaces (so Back is not flooded with keystrokes).
 */
export const useFiltersUrl = () => {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/queue';
  const filters = useMemo(() => parseFilters(params ?? new URLSearchParams()), [params]);
  const set = useCallback(
    (next: TicketFilters, mode: 'push' | 'replace' = 'push') => {
      const qs = serializeFilters(next);
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (mode === 'replace') router.replace(url);
      else router.push(url);
    },
    [router, pathname],
  );
  return { filters, set };
};
