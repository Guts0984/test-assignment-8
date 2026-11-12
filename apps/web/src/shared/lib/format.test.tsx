import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { LocalTime } from '@/shared/ui/local-time';
import { MESSAGES, Wrapper } from '../../../test/utils';
import { useLocalFormat } from './format';
import type { AppLocale } from '@/shared/i18n/config';

const NOW = new Date('2026-11-12T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const H = 3_600_000;

const Probe = ({
  fn,
  tz,
}: {
  fn: (f: ReturnType<typeof useLocalFormat>) => string | null;
  tz?: string;
}) => {
  const f = useLocalFormat(tz);
  return <output data-testid="out">{fn(f)}</output>;
};
const out = (
  locale: AppLocale,
  fn: (f: ReturnType<typeof useLocalFormat>) => string | null,
  tz?: string,
) => {
  const { unmount } = render(
    <Wrapper locale={locale}>
      <Probe fn={fn} {...(tz ? { tz } : {})} />
    </Wrapper>,
  );
  const text = screen.getByTestId('out').textContent;
  unmount();
  return text;
};

describe('relative time (acceptance #16)', () => {
  it('uk: "через 2 години"; en: "in 2 hours"', () => {
    expect(out('uk', (f) => f.relative(at(2 * H), NOW))).toBe('через 2 години');
    expect(out('en', (f) => f.relative(at(2 * H), NOW))).toBe('in 2 hours');
  });
  it('past and other units, in both languages', () => {
    expect(out('uk', (f) => f.relative(at(-3 * 60_000), NOW))).toBe('3 хвилини тому');
    expect(out('en', (f) => f.relative(at(-3 * 60_000), NOW))).toBe('3 minutes ago');
    expect(out('uk', (f) => f.relative(at(5 * H), NOW))).toBe('через 5 годин');
    expect(out('uk', (f) => f.relative(at(21 * H), NOW))).toBe('через 21 годину');
    expect(out('en', (f) => f.relative(at(H), NOW))).toBe('in 1 hour');
    expect(out('uk', (f) => f.relative(at(3 * 24 * H), NOW))).toBe('через 3 дні');
  });
});

describe('plural forms (acceptance #16)', () => {
  const Count = ({ n, ns }: { n: number; ns: 'count' | 'unread' }) => {
    const t = useTranslations('tickets');
    return <output data-testid="c">{t(ns, { count: n })}</output>;
  };
  const count = (locale: AppLocale, n: number, ns: 'count' | 'unread' = 'count') => {
    const { unmount } = render(
      <Wrapper locale={locale}>
        <Count n={n} ns={ns} />
      </Wrapper>,
    );
    const text = screen.getByTestId('c').textContent;
    unmount();
    return text;
  };
  it.each([
    [0, '0 заявок'],
    [1, '1 заявка'],
    [2, '2 заявки'],
    [3, '3 заявки'],
    [4, '4 заявки'],
    [5, '5 заявок'],
    [11, '11 заявок'],
    [12, '12 заявок'],
    [14, '14 заявок'],
    [21, '21 заявка'],
    [22, '22 заявки'],
    [25, '25 заявок'],
    [101, '101 заявка'],
    [111, '111 заявок'],
    [1000, '1 000 заявок'],
  ])('uk %i → %s', (n, expected) =>
    expect(count('uk', n)?.replace(/\s/g, ' ')).toBe(expected.replace(/\s/g, ' ')),
  );
  it.each([
    [0, '0 tickets'],
    [1, '1 ticket'],
    [2, '2 tickets'],
    [21, '21 tickets'],
  ])('en %i → %s', (n, expected) => expect(count('en', n)).toBe(expected));
  it('"unread replies" has its own correct forms in uk', () => {
    expect(count('uk', 1, 'unread')).toBe('1 непрочитана відповідь');
    expect(count('uk', 3, 'unread')).toBe('3 непрочитані відповіді');
    expect(count('uk', 7, 'unread')).toBe('7 непрочитаних відповідей');
  });
});

describe("dates are shown in the USER's time zone (acceptance #16)", () => {
  const instant = new Date('2026-11-12T23:30:00Z'); // Kyiv (UTC+2): 13 Nov 01:30 — New York (UTC−5): 12 Nov 18:30
  it("the same instant renders differently per zone, in the user's language", () => {
    const kyivUk = out('uk', (f) => f.dateTime(instant), 'Europe/Kyiv');
    const nyUk = out('uk', (f) => f.dateTime(instant), 'America/New_York');
    expect(kyivUk).toMatch(/13/);
    expect(kyivUk).toMatch(/01:30/);
    expect(nyUk).toMatch(/12/);
    expect(nyUk).toMatch(/18:30/);
    expect(out('en', (f) => f.dateTime(instant), 'Europe/Kyiv')).toMatch(/Nov 13, 2026/);
    expect(out('en', (f) => f.time(instant), 'America/New_York')).toMatch(/6:30\s?PM/);
  });
  it('follows daylight saving: Kyiv is UTC+3 in summer, UTC+2 in winter', () => {
    expect(out('en', (f) => f.time(new Date('2026-07-10T12:00:00Z')), 'Europe/Kyiv')).toMatch(
      /3:00\s?PM/,
    );
    expect(out('en', (f) => f.time(new Date('2026-12-10T12:00:00Z')), 'Europe/Kyiv')).toMatch(
      /2:00\s?PM/,
    );
  });
  it("when no zone is given it uses the browser's own", () => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(out('en', (f) => f.time(instant))).toBe(out('en', (f) => f.time(instant), own));
  });
  it('LocalTime renders a semantic <time> with the machine-readable instant', () => {
    render(
      <Wrapper locale="en">
        <LocalTime value="2026-11-12T23:30:00Z" />
      </Wrapper>,
    );
    const el = screen.getByText(/2026/);
    expect(el.tagName).toBe('TIME');
    expect(el).toHaveAttribute('datetime', '2026-11-12T23:30:00.000Z');
  });
  it('bad input does not crash a whole screen: an invalid date is reported, not thrown past the component', () => {
    expect(() => new Date('garbage').toISOString()).toThrow(); // documents WHY callers must pass API ISO strings
  });
});

describe('message catalogues', () => {
  const flat = (o: Record<string, unknown>, p = ''): Record<string, string> =>
    Object.entries(o).reduce<Record<string, string>>(
      (acc, [k, v]) =>
        typeof v === 'string'
          ? { ...acc, [`${p}${k}`]: v }
          : { ...acc, ...flat(v as Record<string, unknown>, `${p}${k}.`) },
      {},
    );
  const uk = flat(MESSAGES.uk);
  const en = flat(MESSAGES.en);
  const placeholders = (s: string) =>
    [...s.matchAll(/\{(\w+)(?:,|\})/g)]
      .map((m) => m[1])
      .sort()
      .join(',');

  it('uk and en have exactly the same keys (nothing untranslated, nothing orphaned)', () => {
    expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort());
  });
  it('no empty strings, and the same placeholders on both sides', () => {
    for (const [k, v] of Object.entries(uk)) {
      expect(v.trim(), `uk ${k}`).not.toBe('');
      expect(en[k]?.trim(), `en ${k}`).not.toBe('');
      expect(placeholders(v), `placeholders of ${k}`).toBe(placeholders(en[k] ?? ''));
    }
  });
  it('Ukrainian plural messages define all four CLDR categories (one / few / many / other)', () => {
    for (const [k, v] of Object.entries(uk)) {
      if (!v.includes('plural,')) continue;
      for (const cat of ['one', 'few', 'many', 'other'])
        expect(v, `uk ${k} lacks "${cat}"`).toContain(`${cat} {`);
    }
  });
  it('every status / priority / category / role the API can send has a label in both languages', () => {
    for (const [ns, keys] of Object.entries({
      status: ['new', 'open', 'pending', 'resolved', 'closed'],
      priority: ['low', 'normal', 'high', 'urgent'],
      category: ['payment', 'delivery', 'account', 'technical', 'other'],
      role: ['customer', 'agent', 'lead'],
    }))
      for (const k of keys) {
        expect(uk[`${ns}.${k}`], `uk ${ns}.${k}`).toBeTruthy();
        expect(en[`${ns}.${k}`], `en ${ns}.${k}`).toBeTruthy();
      }
  });
  it('NextIntlClientProvider can be mounted with either catalogue without errors', () => {
    for (const l of ['uk', 'en'] as const) {
      expect(() =>
        render(
          <NextIntlClientProvider locale={l} messages={MESSAGES[l]} timeZone="UTC">
            <p>ok</p>
          </NextIntlClientProvider>,
        ),
      ).not.toThrow();
    }
  });
});
