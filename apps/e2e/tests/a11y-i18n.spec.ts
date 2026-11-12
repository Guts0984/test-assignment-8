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

for (const theme of ['light', 'dark'] as const) {
  for (const locale of ['en', 'uk'] as const) {
    test(`acceptance #17 — axe finds nothing on the main screens (${locale}, ${theme} theme), and there are no hydration errors`, async ({
      browser,
      baseURL,
    }) => {
      const origin = baseURL!;
      const ctx = await browser.newContext({ baseURL });
      await ctx.addCookies([{ name: 'locale', value: locale, url: origin }]);
      const page = await ctx.newPage();
      await setTheme(page, theme);
      const problems = watchConsole(page);

      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      expect(await violations(page), 'login').toEqual([]);

      await signInApi(ctx.request, USERS.customer(12), origin);
      const t = await createTicketApi(ctx.request, { subject: uniq('a11y') }, origin);
      for (const path of ['/tickets', '/tickets/new', `/tickets/${t.id}`]) {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await violations(page), path).toEqual([]);
      }

      await signInApi(ctx.request, USERS.lead, origin);
      for (const path of ['/queue', `/tickets/${t.id}`, '/dashboard', '/settings']) {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await violations(page), path).toEqual([]);
      }
      expect(
        problems.filter((p) => /hydrat|did not match|Minified React error #(418|423|425)/i.test(p)),
      ).toEqual([]);
      await ctx.close();
    });
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
