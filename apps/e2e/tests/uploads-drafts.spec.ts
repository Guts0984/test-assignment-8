import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG, USERS, createTicketApi, signInApi, signInUi, uniq, useEnglish } from './helpers';

test('acceptance #14 — an .exe renamed .png and an 11 MB file are refused', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const ctx = await browser.newContext({ baseURL });
  await useEnglish(ctx, origin);
  const page = await ctx.newPage();
  await signInUi(page, USERS.customer(10));
  await page.goto('/tickets/new');
  const input = page.locator('input[type=file]');

  await input.setInputFiles({
    name: 'holiday.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]),
  });
  await expect(page.getByText('Only images, PDF and text files are allowed')).toBeVisible();

  const hugeFile = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-')), 'huge.txt');
  writeFileSync(hugeFile, Buffer.alloc(11 * 1024 * 1024, 0x61));
  await input.setInputFiles(hugeFile);
  await expect(page.getByText('The file is larger than 10 MB')).toBeVisible();

  // and the server says the same to anyone who skips the UI
  const big = await ctx.request.post('/api/attachments', {
    multipart: {
      file: {
        name: 'huge.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(11 * 1024 * 1024, 0x61),
      },
    },
    headers: { origin },
  });
  expect(big.status()).toBe(413);
  const exe = await ctx.request.post('/api/attachments', {
    multipart: {
      file: {
        name: 'holiday.png',
        mimeType: 'image/png',
        buffer: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]),
      },
    },
    headers: { origin },
  });
  expect(exe.status()).toBe(415);
  await ctx.close();
});

test('acceptance #15 — a half-written ticket and a half-written reply survive a reload', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const ctx = await browser.newContext({ baseURL });
  await useEnglish(ctx, origin);
  const page = await ctx.newPage();
  await signInUi(page, USERS.customer(11));
  await page.goto('/tickets/new');
  await page.getByLabel('Subject').fill('Half-typed subject');
  await page.getByLabel('Category').selectOption('delivery');
  await page.getByLabel('Describe the problem').fill('and a half-typed description');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'draft-shot.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByText('draft-shot.png')).toBeVisible();
  await page.waitForTimeout(700); // the draft is saved shortly after typing stops
  await page.reload();
  await expect(page.getByText('draft-shot.png')).toBeVisible(); // the uploaded file is still attached after the reload
  await expect(page.getByLabel('Subject')).toHaveValue('Half-typed subject');
  await expect(page.getByLabel('Category')).toHaveValue('delivery');
  await expect(page.getByLabel('Describe the problem')).toHaveValue('and a half-typed description');
  await expect(page.getByText('A saved draft was restored')).toBeVisible();

  const ticket = await createTicketApi(ctx.request, { subject: uniq('reply-draft') }, origin);
  await page.goto(`/tickets/${ticket.id}`);
  await page.getByRole('textbox', { name: 'Your reply' }).fill('a reply I have not sent yet');
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Your reply' })).toHaveValue(
    'a reply I have not sent yet',
  );
  await ctx.close();

  // the staff composer keeps its draft per ticket too, including the note/reply mode
  const staffCtx = await browser.newContext({ baseURL });
  await useEnglish(staffCtx, origin);
  await signInApi(staffCtx.request, USERS.agent1, origin);
  const staff = await staffCtx.newPage();
  await staff.goto(`/tickets/${ticket.id}`);
  await staff.getByRole('radio', { name: 'Internal note' }).check();
  await staff.getByRole('textbox', { name: 'Internal note' }).fill('half-written note');
  await staff.waitForTimeout(700);
  await staff.reload();
  await expect(staff.getByRole('radio', { name: 'Internal note' })).toBeChecked();
  await expect(staff.getByRole('textbox', { name: 'Internal note' })).toHaveValue(
    'half-written note',
  );
  await staffCtx.close();
});
