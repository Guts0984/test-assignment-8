import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

export const USERS = {
  lead: { email: 'lead@helpdesk.test', password: 'Lead#2026pass' },
  agent1: { email: 'agent1@helpdesk.test', password: 'Agent#2026pass' }, // payment + other
  agent2: { email: 'agent2@helpdesk.test', password: 'Agent#2026pass' }, // delivery + other
  agent3: { email: 'agent3@helpdesk.test', password: 'Agent#2026pass' }, // account + technical
  customer: (n: number) => ({
    email: `customer${String(n).padStart(3, '0')}@helpdesk.test`,
    password: 'Customer#2026pass',
  }),
};

export const uniq = (label: string) =>
  `E2E ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** English UI so selectors are stable; the Ukrainian UI has its own spec. */
export const useEnglish = async (context: BrowserContext, baseURL: string) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: baseURL }]);
};

/** Signs in through the real form. */
export const signInUi = async (page: Page, who: { email: string; password: string }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
};

/** Signs in via the api (the cookie lands in the browser context): fast set-up for tests about something else. */
export const signInApi = async (
  request: APIRequestContext,
  who: { email: string; password: string },
  origin: string,
) => {
  const res = await request.post('/api/auth/login', { data: who, headers: { origin } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { user: { id: string; name: string; role: string } };
};

export const createTicketApi = async (
  request: APIRequestContext,
  over: { subject: string; category?: string; priority?: string; body?: string },
  origin: string,
) => {
  const res = await request.post('/api/tickets', {
    data: {
      category: 'payment',
      priority: 'normal',
      body: 'Created by an e2e test',
      attachmentIds: [],
      clientMessageId: crypto.randomUUID(),
      ...over,
    },
    headers: { origin },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; code: string; version: number; subject: string };
};

/** Console errors and page errors: hydration mismatches show up here. */
export const watchConsole = (page: Page) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
};

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
