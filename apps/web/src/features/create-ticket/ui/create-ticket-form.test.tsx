import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API,
  MESSAGES,
  envelope,
  http,
  HttpResponse,
  renderApp,
  router,
  server,
} from '../../../../test/utils';
import { CreateTicketForm } from './create-ticket-form';

vi.mock('next/navigation', async () => {
  const utils = await import('../../../../test/utils');
  return {
    useRouter: () => utils.router,
    usePathname: () => '/tickets/new',
    useSearchParams: () => new URLSearchParams(),
  };
});

const U = '22222222-2222-4222-8222-222222222222';
const m = MESSAGES.en.ticket;
let posts: Array<Record<string, unknown>> = [];
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  posts = [];
  window.localStorage.clear();
  Object.values(router).forEach((f) => f.mockClear());
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const form = () => renderApp(<CreateTicketForm userId={U} />, { locale: 'en' });
const subject = () => screen.getByLabelText(m.new.subject) as HTMLInputElement;
const body = () => screen.getByLabelText(m.new.description) as HTMLTextAreaElement;

describe('create ticket form', () => {
  it('empty submit: translated errors on subject and description, linked to their fields', async () => {
    const user = userEvent.setup();
    form();
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    expect(await screen.findAllByText(MESSAGES.en.validation.required)).toHaveLength(2);
    expect(subject()).toHaveAttribute('aria-invalid', 'true');
    expect(body()).toHaveAttribute('aria-invalid', 'true');
    expect(subject()).toHaveFocus();
  });

  it('customers can choose low / normal / high priority — never urgent — and all five categories', () => {
    form();
    const prio = [...(screen.getByLabelText(m.priority) as HTMLSelectElement).options].map(
      (o) => o.textContent,
    );
    expect(prio).toEqual(['Low', 'Normal', 'High']);
    expect((screen.getByLabelText(m.category) as HTMLSelectElement).options).toHaveLength(5);
  });

  it('the subject field cannot even take more than 200 characters (and the schema would refuse 201 anyway)', async () => {
    const user = userEvent.setup();
    form();
    await user.click(subject());
    await user.paste('x'.repeat(250));
    expect(subject().value).toHaveLength(200);
  });

  it('creates the ticket, sends a client message id, clears the draft and opens the new ticket', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets`, async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(
          { id: '77777777-7777-4777-8777-777777777777', code: 'HD-1042' },
          { status: 201 },
        );
      }),
    );
    form();
    await user.type(subject(), '  Cannot pay  ');
    await user.selectOptions(screen.getByLabelText(m.category), 'payment');
    await user.selectOptions(screen.getByLabelText(m.priority), 'high');
    await user.type(body(), 'The card is declined');
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/tickets/77777777-7777-4777-8777-777777777777'),
    );
    expect(posts[0]).toMatchObject({
      subject: 'Cannot pay',
      category: 'payment',
      priority: 'high',
      body: 'The card is declined',
      attachmentIds: [],
    });
    expect(posts[0]?.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(window.localStorage.getItem(`helpdesk:draft:new-ticket:${U}`)).toBeNull();
  });

  it('the draft survives a reload (acceptance #15) — text, category, priority — and says so', async () => {
    const user = userEvent.setup();
    const first = form();
    await user.type(subject(), 'Half-typed subject');
    await user.selectOptions(screen.getByLabelText(m.category), 'delivery');
    await user.type(body(), 'and some description');
    first.unmount(); // leaving the page flushes the debounced save
    form();
    expect(subject().value).toBe('Half-typed subject');
    expect(body().value).toBe('and some description');
    expect((screen.getByLabelText(m.category) as HTMLSelectElement).value).toBe('delivery');
    expect(screen.getByText(m.new.draftRestored)).toBeInTheDocument();
  });

  it('"clear draft" empties the form and the stored draft', async () => {
    const user = userEvent.setup();
    const first = form();
    await user.type(subject(), 'temp');
    first.unmount();
    form();
    await user.click(screen.getByRole('button', { name: m.new.clearDraft }));
    expect(subject().value).toBe('');
    expect(window.localStorage.getItem(`helpdesk:draft:new-ticket:${U}`)).toBeNull();
  });

  it('a failed submit keeps the same idempotency id, so a retry cannot create two tickets', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets`, async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return posts.length === 1
          ? HttpResponse.error()
          : HttpResponse.json(
              { id: '77777777-7777-4777-8777-777777777777', code: 'HD-1' },
              { status: 201 },
            );
      }),
    );
    form();
    await user.type(subject(), 'Subject');
    await user.type(body(), 'Body');
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    expect(await screen.findByTestId('create-error')).toBeInTheDocument();
    expect(subject().value).toBe('Subject');
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.clientMessageId).toBe(posts[0]?.clientMessageId);
  });

  it('the id also survives a reload (a crash between "sent" and "answered" must not duplicate)', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets`, async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.error();
      }),
    );
    const a = form();
    await user.type(subject(), 'S');
    await user.type(body(), 'B');
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    await screen.findByTestId('create-error');
    a.unmount();
    form();
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.clientMessageId).toBe(posts[0]?.clientMessageId);
  });

  it('corrupt / hostile stored drafts are sanitised, not trusted', () => {
    window.localStorage.setItem(
      `helpdesk:draft:new-ticket:${U}`,
      JSON.stringify({
        subject: 'ok',
        category: 'admin',
        priority: 'urgent',
        body: 5,
        clientMessageId: "x'; DROP",
      }),
    );
    form();
    expect(subject().value).toBe('ok');
    expect((screen.getByLabelText(m.category) as HTMLSelectElement).value).toBe('other');
    expect((screen.getByLabelText(m.priority) as HTMLSelectElement).value).toBe('normal');
  });

  it('server refusals are explained (rate limit with seconds)', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/tickets`, () =>
        envelope(429, 'rate_limited', 'slow', { retryAfterSeconds: 7 }),
      ),
    );
    form();
    await user.type(subject(), 'S');
    await user.type(body(), 'B');
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    expect(await screen.findByTestId('create-error')).toHaveTextContent('7 seconds');
  });

  it('attachments: the file is uploaded first, the ticket is created with its id; submit waits while uploading', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/attachments`, async () => {
        await new Promise((r) => setTimeout(r, 80));
        return HttpResponse.json(
          {
            id: '88888888-8888-4888-8888-888888888888',
            name: 'shot.png',
            mime: 'image/png',
            sizeBytes: 5,
          },
          { status: 201 },
        );
      }),
      http.post(`${API}/tickets`, async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(
          { id: '77777777-7777-4777-8777-777777777777', code: 'HD-2' },
          { status: 201 },
        );
      }),
    );
    form();
    await user.type(subject(), 'With file');
    await user.type(body(), 'See attached');
    await user.upload(
      screen.getByLabelText(m.new.attachments, { selector: 'input[type=file]' }),
      new File(['12345'], 'shot.png', { type: 'image/png' }),
    );
    expect(screen.getByRole('button', { name: m.new.submit })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: m.new.submit })).toBeEnabled());
    expect(screen.getByText('shot.png')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: m.new.submit }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.attachmentIds).toEqual(['88888888-8888-4888-8888-888888888888']);
  });

  it('a rejected file (e.g. .exe renamed .png) is shown as an error and is NOT attached', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/attachments`, () => envelope(415, 'unsupported_media_type', 'no')),
    );
    form();
    await user.upload(
      screen.getByLabelText(m.new.attachments, { selector: 'input[type=file]' }),
      new File(['MZ'], 'holiday.png', { type: 'image/png' }),
    );
    expect(await screen.findByText(MESSAGES.en.attach.rejectedType)).toBeInTheDocument();
  });

  it('more than 5 files, or a file over 10 MB, is refused up front with a message', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${API}/attachments`, () =>
        HttpResponse.json(
          { id: crypto.randomUUID(), name: 'f', mime: 'text/plain', sizeBytes: 1 },
          { status: 201 },
        ),
      ),
    );
    form();
    const input = screen.getByLabelText(m.new.attachments, { selector: 'input[type=file]' });
    await user.upload(
      input,
      Array.from({ length: 6 }, (_, i) => new File(['x'], `f${i}.txt`, { type: 'text/plain' })),
    );
    expect(await screen.findByText('At most 5 attachments per message')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.txt', { type: 'text/plain' });
    await user.upload(input, big);
    expect(await screen.findByText(MESSAGES.en.attach.rejectedSize)).toBeInTheDocument();
  });
});
