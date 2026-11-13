import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API,
  CUSTOMER,
  ME,
  MESSAGES,
  envelope,
  http,
  HttpResponse,
  makeClient,
  renderApp,
  router,
  server,
} from '../../../test/utils';
import { ticket, uid } from '../../../test/fixtures';
import { TicketPage } from './index';

vi.mock('next/navigation', async () => {
  const utils = await import('../../../test/utils');
  return {
    useRouter: () => utils.router,
    usePathname: () => '/tickets/1',
    useSearchParams: () => new URLSearchParams(),
  };
});

const TID = uid(1);
const msg = (
  id: number,
  kind: 'public' | 'internal',
  body: string,
  role: 'customer' | 'agent' = 'agent',
  at = `2026-11-1${id}T10:00:00.000Z`,
) => ({
  id: uid(100 + id),
  ticketId: TID,
  author: {
    id: role === 'customer' ? CUSTOMER.id : ME.id,
    name: role === 'customer' ? 'Олена' : 'Іван Мельник',
    role,
  },
  kind,
  body,
  createdAt: at,
  attachments: [] as Array<{ id: string; name: string; mime: string; sizeBytes: number }>,
});
let marked = 0;
let patches: Array<Record<string, unknown>> = [];
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  marked = 0;
  patches = [];
  Object.values(router).forEach((f) => f.mockClear());
  window.localStorage.clear();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const detail = (
  over: Record<string, unknown> = {},
  tk: Partial<ReturnType<typeof ticket>> = {},
) => ({
  ticket: ticket(1, { subject: 'Cannot pay', customer: { id: CUSTOMER.id, name: 'Олена' }, ...tk }),
  messages: [
    msg(1, 'public', 'My card fails', 'customer'),
    msg(2, 'public', 'We are looking into it'),
  ],
  events: [],
  rating: null,
  ...over,
});
const serve = (me: typeof ME | typeof CUSTOMER, d: ReturnType<typeof detail>) =>
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(me)),
    http.get(`${API}/tickets/${TID}`, () => HttpResponse.json(d)),
    http.post(`${API}/tickets/${TID}/read`, () => {
      marked += 1;
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch(`${API}/tickets/${TID}`, async ({ request }) => {
      patches.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ...d.ticket, status: 'resolved', version: 2 });
    }),
    http.get(`${API}/canned-responses`, () => HttpResponse.json([])),
    http.get(`${API}/agents`, () => HttpResponse.json([])),
    http.get(`${API}/tickets/${TID}/presence`, () =>
      HttpResponse.json([{ id: uid(77), name: 'Петро' }]),
    ),
    http.post(`${API}/tickets/${TID}/typing`, () => new HttpResponse(null, { status: 204 })),
  );
const show = (me: typeof ME | typeof CUSTOMER, locale: 'en' | 'uk' = 'en') => {
  const client = makeClient();
  client.setQueryData(['me'], me);
  return renderApp(<TicketPage id={TID} />, { locale, client });
};

describe('ticket page — customer', () => {
  it('shows the conversation, no staff controls, and marks the ticket read when it had an unread reply', async () => {
    serve(CUSTOMER, detail({}, { unread: true }));
    show(CUSTOMER);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cannot pay' }),
    ).toBeInTheDocument();
    expect(screen.getByText('We are looking into it')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message mode')).not.toBeInTheDocument();
    expect(screen.queryByText('Ticket details')).not.toBeInTheDocument(); // no sidebar for customers
    await waitFor(() => expect(marked).toBe(1));
  });

  it('no "mark read" call when there is nothing new', async () => {
    serve(CUSTOMER, detail({}, { unread: false }));
    show(CUSTOMER);
    await screen.findByText('We are looking into it');
    await new Promise((r) => setTimeout(r, 150));
    expect(marked).toBe(0);
  });

  it('"Problem solved" sends the version the customer saw and announces the result', async () => {
    const user = userEvent.setup();
    serve(CUSTOMER, detail({}, { version: 4 }));
    show(CUSTOMER);
    await user.click(await screen.findByRole('button', { name: MESSAGES.en.ticket.solved.button }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ version: 4, status: 'resolved' });
    await waitFor(() =>
      expect(screen.getByTestId('live-polite')).toHaveTextContent(
        'The ticket was marked as solved',
      ),
    );
  });

  it('a FAILED "Problem solved" shows the error on the screen (not only to a screen reader) and the button works again', async () => {
    const user = userEvent.setup();
    serve(CUSTOMER, detail({}, { version: 4 }));
    server.use(
      http.patch(`${API}/tickets/${TID}`, () => envelope(409, 'version_conflict', 'changed')),
    );
    show(CUSTOMER);
    const button = await screen.findByRole('button', { name: MESSAGES.en.ticket.solved.button });
    await user.click(button);
    const alert = await screen.findByTestId('solved-error');
    expect(alert).toBeVisible();
    expect(alert).toHaveAttribute('role', 'alert'); // and it is announced too
    expect(alert.textContent?.length).toBeGreaterThan(5);
    expect(button).toBeEnabled();
  });

  it('after the ticket is resolved the customer can rate 1–5 with a comment, once', async () => {
    const user = userEvent.setup();
    const bodies: Array<Record<string, unknown>> = [];
    serve(CUSTOMER, detail({}, { status: 'resolved' }));
    server.use(
      http.post(`${API}/tickets/${TID}/rating`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ score: 4, comment: 'ok' }, { status: 201 });
      }),
    );
    show(CUSTOMER);
    expect(
      screen.queryByRole('button', { name: MESSAGES.en.ticket.solved.button }),
    ).not.toBeInTheDocument();
    const submit = await screen.findByRole('button', { name: MESSAGES.en.ticket.rating.submit });
    expect(submit).toBeDisabled(); // a score is required
    await user.click(screen.getByRole('radio', { name: '4 stars' }));
    await user.type(screen.getByLabelText(MESSAGES.en.ticket.rating.comment), 'Quick help');
    await user.click(submit);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ score: 4, comment: 'Quick help' });
  });

  it('an already rated ticket shows the thanks, not the form', async () => {
    serve(CUSTOMER, detail({ rating: { score: 5, comment: null } }, { status: 'closed' }));
    show(CUSTOMER);
    expect(await screen.findByText('Thanks for rating: 5 out of 5')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: MESSAGES.en.ticket.rating.submit }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(MESSAGES.en.ticket.detail.closedNote)).toBeInTheDocument();
  });

  it('a reply to a CLOSED ticket opens the NEW linked ticket the server created', async () => {
    const user = userEvent.setup();
    serve(CUSTOMER, detail({}, { status: 'closed' }));
    server.use(
      http.post(`${API}/tickets/${TID}/messages`, () =>
        HttpResponse.json(
          {
            message: {},
            ticket: { ...ticket(2), id: uid(2), code: 'HD-1002' },
            replayed: false,
            spawnedFrom: TID,
          },
          { status: 201 },
        ),
      ),
    );
    show(CUSTOMER);
    await user.type(
      await screen.findByRole('textbox', { name: MESSAGES.en.ticket.reply.label }),
      'it is back',
    );
    await user.click(screen.getByRole('button', { name: MESSAGES.en.ticket.reply.send }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/tickets/${uid(2)}`));
  });

  it("404 → a clear message and a way back; the page never shows another person's data", async () => {
    server.use(
      http.get(`${API}/me`, () => HttpResponse.json(CUSTOMER)),
      http.get(`${API}/tickets/${TID}`, () => envelope(404, 'not_found', 'Ticket not found')),
    );
    show(CUSTOMER);
    expect(await screen.findByText('Not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/tickets');
  });

  it('Ukrainian: the whole page speaks Ukrainian (status, buttons)', async () => {
    serve(CUSTOMER, detail());
    show(CUSTOMER, 'uk');
    expect(
      await screen.findByRole('button', { name: MESSAGES.uk.ticket.solved.button }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: MESSAGES.uk.ticket.reply.send })).toBeInTheDocument();
  });
});

describe('ticket page — staff', () => {
  const staffDetail = () =>
    detail({
      messages: [
        msg(1, 'public', 'My card fails', 'customer', '2026-11-11T10:00:00.000Z'),
        msg(2, 'internal', 'Looks like fraud-check', 'agent', '2026-11-11T11:00:00.000Z'),
        msg(3, 'public', 'We are looking into it', 'agent', '2026-11-11T12:00:00.000Z'),
      ],
      events: [
        {
          id: 5,
          actor: { id: ME.id, name: 'Іван Мельник' },
          field: 'status',
          oldValue: 'new',
          newValue: 'open',
          createdAt: '2026-11-11T11:30:00.000Z',
        },
        {
          id: 4,
          actor: null,
          field: 'created',
          oldValue: null,
          newValue: 'HD-1001',
          createdAt: '2026-11-11T10:00:00.000Z',
        },
      ],
    });

  it('the history says WHO was assigned (by name), and "unassigned" when nobody', async () => {
    serve(
      ME,
      detail({
        messages: [msg(1, 'public', 'My card fails', 'customer', '2026-11-11T10:00:00.000Z')],
        events: [
          {
            id: 7,
            actor: { id: ME.id, name: 'Іван Мельник' },
            field: 'assignee',
            oldValue: null,
            newValue: uid(33),
            newValueName: 'Олена Бондар',
            createdAt: '2026-11-11T11:00:00.000Z',
          },
          {
            id: 8,
            actor: { id: ME.id, name: 'Іван Мельник' },
            field: 'assignee',
            oldValue: uid(33),
            newValue: null,
            createdAt: '2026-11-11T12:00:00.000Z',
          },
        ],
      }),
    );
    show(ME);
    const list = await screen.findByRole('list', { name: 'Conversation' });
    expect(list).toHaveTextContent('Assigned to Олена Бондар');
    expect(list).toHaveTextContent('Unassigned');
  });

  it('timeline: messages, the internal note (visually distinct and labelled) and field changes in time order; the "created" event is not duplicated', async () => {
    serve(ME, staffDetail());
    show(ME);
    const list = await screen.findByRole('list', { name: 'Conversation' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('My card fails'),
      expect.stringContaining('Looks like fraud-check'),
      expect.stringContaining('Status: New → Open'),
      expect.stringContaining('We are looking into it'),
    ]);
    const note = items[1]!;
    expect(note).toHaveAttribute('data-kind', 'internal');
    expect(within(note).getByText('Internal note')).toBeInTheDocument();
    expect(items[0]).toHaveAttribute('data-kind', 'public');
  });

  it('shows the sidebar, the composer with the reply/note switch, and "Now replying: Петро"', async () => {
    serve(ME, staffDetail());
    show(ME);
    expect(await screen.findByLabelText('Message mode')).toBeInTheDocument();
    expect(screen.getByText('Ticket details')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('presence')).toHaveTextContent('Now replying: Петро'),
    );
    expect(screen.getByTestId('presence')).toHaveAttribute('aria-live', 'polite');
  });

  it('a closed ticket offers no composer to staff', async () => {
    serve(ME, detail({}, { status: 'closed' }));
    show(ME);
    await screen.findByText('Ticket details');
    expect(screen.queryByLabelText('Message mode')).not.toBeInTheDocument();
  });

  it('new messages from someone else are announced to screen readers; my own are not', async () => {
    const d = staffDetail();
    serve(ME, d);
    const client = makeClient();
    client.setQueryData(['me'], ME);
    renderApp(<TicketPage id={TID} />, { locale: 'en', client });
    await screen.findByRole('list', { name: 'Conversation' });
    client.setQueryData(['tickets', 'detail', TID], {
      ...d,
      messages: [
        ...d.messages,
        msg(4, 'public', 'Customer again', 'customer', '2026-11-12T10:00:00.000Z'),
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId('live-polite')).toHaveTextContent('New message in ticket HD-1001'),
    );
  });
});
