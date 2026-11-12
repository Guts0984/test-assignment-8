'use client';
import { useFormatter, useLocale } from 'next-intl';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
/** false while rendering on the server and during hydration, true afterwards (no hydration mismatches). */
export const useIsClient = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

/** The browser's IANA time zone, e.g. "Europe/Kyiv". */
export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

type DateInput = Date | string | number;

/**
 * Date/time formatting in the USER'S time zone and language. Because the zone is only known in the browser, these
 * return `null` on the server / during hydration — callers render a placeholder first, then the value.
 */
export const useLocalFormat = (timeZone?: string) => {
  const f = useFormatter();
  const locale = useLocale();
  const client = useIsClient();
  const tz = timeZone ?? (client ? browserTimeZone() : undefined);
  return {
    ready: client,
    locale,
    dateTime: (v: DateInput): string | null =>
      tz
        ? f.dateTime(new Date(v), { dateStyle: 'medium', timeStyle: 'short', timeZone: tz })
        : null,
    date: (v: DateInput): string | null =>
      tz ? f.dateTime(new Date(v), { dateStyle: 'medium', timeZone: tz }) : null,
    time: (v: DateInput): string | null =>
      tz ? f.dateTime(new Date(v), { timeStyle: 'short', timeZone: tz }) : null,
    /** "in 2 hours" / "через 2 години" / "3 minutes ago". */
    relative: (v: DateInput, now: DateInput = Date.now()): string | null =>
      client ? f.relativeTime(new Date(v), new Date(now)) : null,
  };
};
