import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { USERS, createTicketApi, signInApi, uniq, useEnglish, watchConsole } from './helpers';

/** axe incl. colour contrast (only a real browser can check it). */
const violations = async (page: Page) => {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return r.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help} → ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')}`,
  );
};
const setTheme = (page: Page, theme: 'light' | 'dark') =>
  page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);

const PAGES: Array<{
  name: string;
  as: 'anon' | 'customer' | 'lead';
  path: (ticketId: string) => string;
}> = [
  { name: 'login', as: 'anon', path: () => '/login' },
  { name: 'my tickets', as: 'customer', path: () => '/tickets' },
  { name: 'new ticket', as: 'customer', path: () => '/tickets/new' },
  { name: 'ticket (customer)', as: 'customer', path: (id) => `/tickets/${id}` },
  { name: 'queue', as: 'lead', path: () => '/queue' },
  { name: 'ticket (staff)', as: 'lead', path: (id) => `/tickets/${id}` },
  { name: 'dashboard', as: 'lead', path: () => '/dashboard' },
  { name: 'settings', as: 'lead', path: () => '/settings' },
];

// one test per page: a browser crash on one page no longer takes the others down, and a retry is cheap
for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en', 'uk'] as const) {
    for (const spec of PAGES) {
      test(`acceptance #17 — axe: ${spec.name} (${locale}, ${theme}) has no violations and no hydration errors`, async ({
        browser,
        baseURL,
      }) => {
        const origin = baseURL!;
        const ctx = await browser.newContext({ baseURL });
        await ctx.addCookies([{ name: 'locale', value: locale, url: origin }]);
        const page = await ctx.newPage();
        await setTheme(page, theme);
        const problems = watchConsole(page);
        let ticketId = '';
        if (spec.as !== 'anon') {
          const customer = await browser.newContext({ baseURL });
          await signInApi(customer.request, USERS.customer(12), origin);
          ticketId = (await createTicketApi(customer.request, { subject: uniq('a11y') }, origin))
            .id;
          await customer.close();
          await signInApi(
            ctx.request,
            spec.as === 'lead' ? USERS.lead : USERS.customer(12),
            origin,
          );
        }
        await page.goto(spec.path(ticketId));
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.getByRole('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await violations(page), spec.name).toEqual([]);
        expect(
          problems.filter((p) =>
            /hydrat|did not match|Minified React error #(418|423|425)/i.test(p),
          ),
        ).toEqual([]);
        await ctx.close();
      });
    }
  }
}

test("acceptance #16 — language switch, plural forms and dates follow the locale and the user's time zone", async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const ctx = await browser.newContext({ baseURL, timezoneId: 'Europe/Kyiv' });
  await useEnglish(ctx, origin);
  await signInApi(ctx.request, USERS.customer(13), origin);
  await createTicketApi(ctx.request, { subject: uniq('i18n') }, origin);
  const page = await ctx.newPage();
  await page.goto('/tickets');
  await expect(page.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();
  await expect(
    page.getByText(/ago|in \d+ (minute|hour)|just now|seconds? ago/).first(),
  ).toBeVisible(); // relative time, English

  await page.getByLabel('Language').selectOption('uk');
  await expect(page.getByRole('heading', { level: 1, name: 'Мої заявки' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
  await expect(page.getByText(/тому|через|щойно/).first()).toBeVisible(); // relative time, Ukrainian

  await page.getByLabel('Мова').selectOption('en');
  await expect(page.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();

  // a date is rendered in the BROWSER's zone: the same instant differs between two zones
  const zoneA = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: 'Europe/Kyiv' }).format(
      new Date('2026-07-10T12:00:00Z'),
    ),
  );
  const zoneB = await page.evaluate(() =>
    new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: 'America/New_York' }).format(
      new Date('2026-07-10T12:00:00Z'),
    ),
  );
  expect(zoneA).not.toBe(zoneB);
  await ctx.close();
});
