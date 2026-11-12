import { expect, test } from '@playwright/test';
import { USERS, createTicketApi, signInApi, signInUi, uniq, useEnglish } from './helpers';

test('acceptance #7 — two staff members change one ticket: the second gets a conflict and loses nothing', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const customer = await browser.newContext({ baseURL });
  await signInApi(customer.request, USERS.customer(7), origin);
  const ticket = await createTicketApi(
    customer.request,
    { subject: uniq('conflict'), category: 'payment' },
    origin,
  );

  const [aCtx, lCtx] = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  await Promise.all([useEnglish(aCtx, origin), useEnglish(lCtx, origin)]);
  const [agent, lead] = await Promise.all([aCtx.newPage(), lCtx.newPage()]);
  await signInUi(agent, USERS.agent1);
  await signInUi(lead, USERS.lead);
  await agent.goto(`/tickets/${ticket.id}`);
  await lead.goto(`/tickets/${ticket.id}`);
  await expect(agent.getByLabel('Priority')).toBeVisible();
  await expect(lead.getByLabel('Priority')).toBeVisible();

  // the agent is ALREADY editing (their form is dirty) when the lead saves — otherwise the live update would simply be followed
  await agent.getByLabel('Tags').fill('my-new-tag');
  await agent.getByLabel('Status').selectOption('pending');
  await expect(agent.getByRole('button', { name: 'Save changes' })).toBeEnabled();

  await lead.getByLabel('Priority').selectOption('urgent');
  await lead.getByRole('button', { name: 'Save changes' }).click();
  await expect
    .poll(
      async () =>
        (await (await aCtx.request.get(`/api/tickets/${ticket.id}`)).json()).ticket.priority,
    )
    .toBe('urgent');

  // the agent saves on the old version → conflict; what they typed is still there
  await agent.getByRole('button', { name: 'Save changes' }).click();
  const conflict = agent.getByTestId('conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('Someone else has changed this ticket');
  await expect(agent.getByLabel('Tags')).toHaveValue('my-new-tag');
  await expect(agent.getByLabel('Status')).toHaveValue('pending');

  // nothing was overwritten silently: the lead's priority is intact, the agent's edits were not applied
  const current = await (await aCtx.request.get(`/api/tickets/${ticket.id}`)).json();
  expect(current.ticket.priority).toBe('urgent');
  expect(current.ticket.status).not.toBe('pending');
  expect(current.ticket.tags).not.toContain('my-new-tag');

  // keep my edits on top of the current version → the save now succeeds and the lead's change survives
  await agent.getByRole('button', { name: 'Keep my edits on top of the current version' }).click();
  await agent.getByRole('button', { name: 'Save changes' }).click();
  await expect(agent.getByTestId('conflict')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await aCtx.request.get(`/api/tickets/${ticket.id}`)).json()).ticket.status,
    )
    .toBe('pending');
  const after = await (await aCtx.request.get(`/api/tickets/${ticket.id}`)).json();
  expect(after.ticket).toMatchObject({ priority: 'urgent', status: 'pending' });
  expect(after.ticket.tags).toContain('my-new-tag');
  await Promise.all([customer.close(), aCtx.close(), lCtx.close()]);
});

test('acceptance #12 — bulk action: applied to the rest, a report with reasons for the skipped', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const prefix = uniq('bulk');
  const customer = await browser.newContext({ baseURL });
  await signInApi(customer.request, USERS.customer(8), origin);
  const tickets = [] as Array<{ id: string; version: number }>;
  for (let i = 0; i < 3; i += 1)
    tickets.push(
      await createTicketApi(
        customer.request,
        { subject: `${prefix} ${i}`, category: 'payment' },
        origin,
      ),
    );

  const ctx = await browser.newContext({ baseURL });
  await useEnglish(ctx, origin);
  await signInApi(ctx.request, USERS.lead, origin);
  const done = await ctx.request.patch(`/api/tickets/${tickets[0]!.id}`, {
    data: { version: 1, status: 'resolved' },
    headers: { origin },
  });
  expect(done.status()).toBe(200); // a resolved ticket cannot go back to "waiting for customer"

  const lead = await ctx.newPage();
  await lead.goto('/queue');
  await lead.getByLabel('Search subject and messages').fill(prefix);
  await expect(lead.getByRole('row')).toHaveCount(4); // header + 3
  await lead.getByRole('checkbox', { name: 'Select all on this page' }).check();
  await lead.getByLabel('Choose an action').selectOption('status');
  await lead.getByLabel('Status', { exact: true }).selectOption('pending');
  await lead.getByRole('button', { name: 'Apply to selected' }).click();
  const report = lead.getByTestId('bulk-report');
  await expect(report).toContainText('applied to 2, skipped 1');
  await expect(report).toContainText('status change not allowed');
  await expect(report).toContainText(`${prefix} 0`);
  await Promise.all([customer.close(), ctx.close()]);
});

test('acceptance #13 — filters live in the URL: reload and Back restore them; hotkeys work', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const ctx = await browser.newContext({ baseURL });
  await useEnglish(ctx, origin);
  const page = await ctx.newPage();
  await signInUi(page, USERS.lead);
  await page.goto('/queue');
  await expect(page.getByRole('row').nth(1)).toBeVisible();

  await page.getByRole('checkbox', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Open', exact: true })).toBeChecked();
  await expect(page).toHaveURL(/status=open/);
  await page.getByRole('checkbox', { name: 'High', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'High', exact: true })).toBeChecked();
  await expect(page).toHaveURL(/priority=high/);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Open', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'High', exact: true })).toBeChecked();

  await page.goBack(); // Back removes the last change only
  await expect(page.getByRole('checkbox', { name: 'High', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Open', exact: true })).toBeChecked();
  await page.goBack();
  await expect(page.getByRole('checkbox', { name: 'Open', exact: true })).not.toBeChecked();

  await page.getByRole('button', { name: 'Unassigned' }).click(); // a saved view
  await expect(page).toHaveURL(/assignee=none/);

  // keyboard: j highlights a row, / jumps to search (and typing there is not a shortcut), ? opens the help
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  await expect(page.locator('tr[aria-current="true"]')).toHaveCount(1);
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search subject and messages')).toBeFocused();
  await page.keyboard.type('j?k');
  await expect(page.getByLabel('Search subject and messages')).toHaveValue('j?k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Search subject and messages').blur();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await ctx.close();
});

test('take next: the most urgent free ticket of my categories is assigned to me', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const customer = await browser.newContext({ baseURL });
  await signInApi(customer.request, USERS.customer(9), origin);
  const subject = uniq('urgent-free');
  await createTicketApi(
    customer.request,
    { subject, category: 'account', priority: 'high' },
    origin,
  );
  const ctx = await browser.newContext({ baseURL });
  await useEnglish(ctx, origin);
  const page = await ctx.newPage();
  await signInUi(page, USERS.agent3);
  await page.goto('/queue');
  await page.getByRole('button', { name: 'Take next' }).click();
  await expect(page).toHaveURL(/\/tickets\//);
  await expect(page.getByLabel('Assignee')).toContainText('Андрій');
  await Promise.all([customer.close(), ctx.close()]);
});
