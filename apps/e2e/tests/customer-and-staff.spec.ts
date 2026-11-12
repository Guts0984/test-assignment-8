import { expect, test } from '@playwright/test';
import {
  PNG,
  USERS,
  createTicketApi,
  signInApi,
  signInUi,
  uniq,
  useEnglish,
  watchConsole,
} from './helpers';

test.describe('acceptance #3 — a customer writes, support answers, the customer sees it live', () => {
  test.describe.configure({ timeout: 180_000 }); // two browser contexts + two sign-ins: WebKit/Firefox on CI need more than 60 s

  test('customer creates a ticket with an attachment; an agent replies; the customer sees the reply WITHOUT reloading', async ({
    browser,
    baseURL,
  }) => {
    const origin = baseURL!;
    const subject = uniq('pay');
    const customerCtx = await browser.newContext({ baseURL });
    const agentCtx = await browser.newContext({ baseURL });
    await useEnglish(customerCtx, origin);
    await useEnglish(agentCtx, origin);
    const customer = await customerCtx.newPage();
    const agent = await agentCtx.newPage();
    const problems = watchConsole(customer);

    await signInUi(customer, USERS.customer(3));
    await customer.getByRole('link', { name: 'New ticket' }).first().click();
    await customer.getByLabel('Subject').fill(subject);
    await customer.getByLabel('Category').selectOption('payment');
    await customer.getByLabel('Priority').selectOption('high');
    await customer.getByLabel('Describe the problem').fill('My card is declined at checkout.');
    await customer
      .locator('input[type=file]')
      .setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG });
    await expect(customer.getByText('screenshot.png')).toBeVisible();
    await expect(customer.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
    await customer.getByRole('button', { name: 'Create ticket' }).click();
    await expect(customer.getByRole('heading', { level: 1, name: subject })).toBeVisible({
      timeout: 20_000,
    });
    await expect(customer.getByRole('link', { name: /screenshot\.png/ })).toBeVisible();
    const ticketUrl = customer.url();

    await signInUi(agent, USERS.agent1);
    await agent.goto('/queue');
    await agent.getByLabel('Search subject and messages').fill(subject);
    await expect(agent).toHaveURL(/[?&]q=/); // the debounced search has landed in the URL; a late replace must not override the click below
    await agent.getByRole('link', { name: subject }).click();
    await expect(agent.getByRole('heading', { level: 1, name: subject })).toBeVisible();
    await agent
      .getByRole('textbox', { name: 'Reply to customer' })
      .fill('We are checking this with the payment provider.');
    await agent.getByRole('button', { name: 'Send reply' }).click();
    await expect(agent.getByText('We are checking this with the payment provider.')).toBeVisible();

    // the customer's page was never reloaded: the reply and the new status arrive by themselves
    expect(customer.url()).toBe(ticketUrl);
    await expect(customer.getByText('We are checking this with the payment provider.')).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(customer.getByText('Open', { exact: true }).first()).toBeVisible(); // new → open by the rules
    await expect(customer.getByTestId('live-polite')).toContainText(
      'There is a new reply from support',
    );
    expect(problems.filter((p) => /hydrat|did not match/i.test(p))).toEqual([]);
    await customerCtx.close();
    await agentCtx.close();
  });
});

test.describe('acceptance #4 — an internal note is invisible to the customer everywhere', () => {
  test("UI, direct API request and the note's attachment", async ({ browser, baseURL }) => {
    const origin = baseURL!;
    const subject = uniq('note');
    const secret = `hidden-${Date.now().toString(36)}`;
    const customerCtx = await browser.newContext({ baseURL });
    const agentCtx = await browser.newContext({ baseURL });
    await useEnglish(customerCtx, origin);
    await useEnglish(agentCtx, origin);
    await signInApi(customerCtx.request, USERS.customer(4), origin);
    const ticket = await createTicketApi(customerCtx.request, { subject }, origin);

    const agent = await agentCtx.newPage();
    await signInUi(agent, USERS.agent1);
    await agent.goto(`/tickets/${ticket.id}`);
    await agent.getByRole('radio', { name: 'Internal note' }).check();
    await expect(agent.getByTestId('visibility-hint')).toHaveText('The customer will NOT see this');
    await agent
      .getByRole('textbox', { name: 'Internal note' })
      .fill(`${secret} do not tell the customer`);
    await agent
      .locator('input[type=file]')
      .setInputFiles({ name: 'internal-log.png', mimeType: 'image/png', buffer: PNG });
    await expect(agent.getByText('internal-log.png')).toBeVisible();
    await agent.getByRole('button', { name: 'Save note' }).click();
    await expect(agent.getByText(`${secret} do not tell the customer`)).toBeVisible();
    const note = agent.locator('[data-kind="internal"]');
    await expect(note.getByText('Internal note')).toBeVisible();
    const href = await note.getByRole('link', { name: /internal-log\.png/ }).getAttribute('href');
    expect(href).toMatch(/\/api\/attachments\//);

    const customer = await customerCtx.newPage();
    await customer.goto(`/tickets/${ticket.id}`);
    await expect(customer.getByRole('heading', { level: 1, name: subject })).toBeVisible();
    await expect(customer.getByText(secret)).toHaveCount(0);
    await expect(customer.locator('[data-kind="internal"]')).toHaveCount(0);

    const detail = await customerCtx.request.get(`/api/tickets/${ticket.id}`);
    expect(await detail.text()).not.toContain(secret);
    expect(await detail.text()).not.toContain('internal-log.png');
    expect(
      (
        (await (await customerCtx.request.get(`/api/tickets?q=${secret}`)).json()) as {
          items: unknown[];
        }
      ).items,
    ).toEqual([]);

    expect((await customerCtx.request.get(href!)).status()).toBe(404);
    const asAgent = await agentCtx.request.get(href!);
    expect(asAgent.status()).toBe(200);
    expect(asAgent.headers()['content-type']).toBe('image/png');
    await customerCtx.close();
    await agentCtx.close();
  });
});

test.describe("acceptance #5 — other people's tickets are refused by direct link", () => {
  test('another customer and an agent of another category', async ({ browser, baseURL }) => {
    const origin = baseURL!;
    const owner = await browser.newContext({ baseURL });
    await signInApi(owner.request, USERS.customer(5), origin);
    const ticket = await createTicketApi(
      owner.request,
      { subject: uniq('private'), category: 'payment' },
      origin,
    );
    for (const [who, label] of [
      [USERS.customer(6), 'another customer'],
      [USERS.agent2, 'agent of another category'],
    ] as const) {
      const ctx = await browser.newContext({ baseURL });
      await useEnglish(ctx, origin);
      const page = await ctx.newPage();
      await signInUi(page, who);
      await page.goto(`/tickets/${ticket.id}`);
      await expect(page.getByText('Not found.'), label).toBeVisible();
      expect((await ctx.request.get(`/api/tickets/${ticket.id}`)).status(), label).toBe(404);
      await ctx.close();
    }
    await owner.close();
  });
});
