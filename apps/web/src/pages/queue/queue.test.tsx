import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  API,
  ME,
  MESSAGES,
  http,
  HttpResponse,
  makeClient,
  router,
  server,
} from '../../../test/utils';
import { ticket, uid } from '../../../test/fixtures';
import { AnnouncerProvider } from '@/shared/ui/announcer';
import { applyTicketToLists } from '@/features/realtime/model/live-updates';
import { QueuePage } from './index';

const search = { current: new URLSearchParams() };
vi.mock('next/navigation', async () => {
  const utils = await import('../../../test/utils');
  return {
    useRouter: () => utils.router,
    usePathname: () => '/queue',
    useSearchParams: () => search.current,
  };
});

const ME_ID = ME.id;
let requests: string[] = [];
const rows = [1, 2, 3, 4, 5].map((n) =>
  ticket(n, {
    createdAt: `2026-11-${20 - n}T10:00:00.000Z`,
    updatedAt: `2026-11-${20 - n}T10:00:00.000Z`,
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  requests = [];
  search.current = new URLSearchParams();
  Object.values(router).forEach((f) => f.mockClear());
  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(ME)),
    http.get(`${API}/agents`, () =>
      HttpResponse.json([{ id: ME_ID, name: 'Іван', categories: ['payment'] }]),
    ),
    http.get(`${API}/saved-views`, () =>
      HttpResponse.json([
        { id: uid(70), name: 'Моя вистава', query: { status: ['pending'], priority: ['high'] } },
      ]),
    ),
    http.get(`${API}/tickets`, ({ request }) => {
      requests.push(new URL(request.url).search);
      return HttpResponse.json({ items: rows, nextCursor: null });
    }),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mount = () => {
  const client = makeClient();
  client.setQueryData(['me'], ME);
  const view = render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={MESSAGES.en} timeZone="UTC">
        <AnnouncerProvider>
          <QueuePage />
        </AnnouncerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { client, ...view };
};
const body = () => screen.getAllByRole('row').slice(1);

describe('queue: filters live in the URL (acceptance #13)', () => {
  it('filters from the URL are applied to the request (restored after reload)', async () => {
    search.current = new URLSearchParams(
      'status=open,pending&priority=high&assignee=me&sort=sla&order=asc&q=refund',
    );
    mount();
    await screen.findByText('Subject 1');
    const q = new URLSearchParams(requests[0]);
    expect(q.get('status')).toBe('open,pending');
    expect(q.get('priority')).toBe('high');
    expect(q.get('assignee')).toBe('me');
    expect(q.get('sort')).toBe('sla');
    expect(q.get('order')).toBe('asc');
    expect(q.get('q')).toBe('refund');
    expect(screen.getByRole('checkbox', { name: 'Open' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Waiting for customer' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Closed' })).not.toBeChecked();
    expect((screen.getByLabelText('Search subject and messages') as HTMLInputElement).value).toBe(
      'refund',
    );
  });

  it('changing a filter PUSHES a history entry (so Back works); typing in search REPLACES it (no history flood)', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    await user.click(screen.getByRole('checkbox', { name: 'Open' }));
    expect(router.push).toHaveBeenCalledWith('/queue?status=open');
    await user.type(screen.getByLabelText('Search subject and messages'), 'abc');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/queue?q=abc'));
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('a hand-edited garbage URL does not break the page', async () => {
    search.current = new URLSearchParams(
      "status=bogus&priority='; DROP&assignee=nobody&sort=password&createdFrom=yesterday&q=" +
        'x'.repeat(500),
    );
    mount();
    expect(await screen.findByText('Subject 1')).toBeInTheDocument();
    const q = new URLSearchParams(requests[0]);
    expect(q.has('status')).toBe(false);
    expect(q.get('sort')).toBe('created');
    expect(q.get('q')).toHaveLength(200);
  });

  it('built-in and saved views apply their filters; the active one is pressed', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    await user.click(screen.getByRole('button', { name: 'My open' }));
    expect(router.push).toHaveBeenLastCalledWith('/queue?status=new%2Copen&assignee=me');
    await user.click(await screen.findByRole('button', { name: 'Моя вистава' }));
    expect(router.push).toHaveBeenLastCalledWith('/queue?status=pending&priority=high');
    search.current = new URLSearchParams('assignee=none&status=new,open');
    document.body.innerHTML = '';
    mount();
    expect(await screen.findByRole('button', { name: 'Unassigned' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('queue: keyboard (acceptance: j/k/Enter, / and ?)', () => {
  it('j and k move the highlighted row, Enter opens it, / focuses the search, ? opens the help (Esc closes it)', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    await user.keyboard('j');
    expect(body()[0]).toHaveAttribute('aria-current', 'true');
    await user.keyboard('jj');
    expect(body()[2]).toHaveAttribute('aria-current', 'true');
    await user.keyboard('k');
    expect(body()[1]).toHaveAttribute('aria-current', 'true');
    await user.keyboard('{Enter}');
    expect(router.push).toHaveBeenCalledWith(`/tickets/${rows[1]?.id}`);
    await user.keyboard('/');
    expect(screen.getByLabelText('Search subject and messages')).toHaveFocus();
    await user.keyboard('{Escape}');
    (document.activeElement as HTMLElement).blur(); // body.focus() does not blur an input in jsdom
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Next ticket')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('typing "j", "k", "/" or "?" into the search box does NOT trigger shortcuts', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    await user.click(screen.getByLabelText('Search subject and messages'));
    await user.keyboard('jk/?');
    expect(body().some((r) => r.getAttribute('aria-current') === 'true')).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Search subject and messages') as HTMLInputElement).value).toBe(
      'jk/?',
    );
  });

  it('clamps at both ends of the list', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    await user.keyboard('k'); // from "nothing", k goes to the LAST row
    expect(body()[4]).toHaveAttribute('aria-current', 'true');
    await user.keyboard('kkkkkkkk');
    expect(body()[0]).toHaveAttribute('aria-current', 'true'); // stops at the top
    await user.keyboard('jjjjjjjjj');
    expect(body()[4]).toHaveAttribute('aria-current', 'true'); // stops at the bottom
  });
});

describe('queue: selection, bulk actions and the report of skipped tickets (acceptance #12)', () => {
  it('selecting rows shows the bulk bar with a plural-correct count; select-all selects the page', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    expect(screen.queryByTestId('selected-count')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select ticket HD-1001' }));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('1 ticket selected');
    await user.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('5 tickets selected');
    await user.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    expect(screen.queryByTestId('selected-count')).not.toBeInTheDocument();
  });

  it('applies the action to the selected tickets and reports what was skipped and WHY, per ticket', async () => {
    const user = userEvent.setup();
    let sentBody: { ids: string[]; operation: unknown } | undefined;
    server.use(
      http.post(`${API}/tickets/bulk`, async ({ request }) => {
        sentBody = (await request.json()) as typeof sentBody;
        return HttpResponse.json({
          results: [
            { id: rows[0]!.id, ok: true },
            { id: rows[1]!.id, ok: false, reason: 'invalid_transition' },
            { id: rows[2]!.id, ok: false, reason: 'not_found_or_forbidden' },
            { id: rows[3]!.id, ok: false, reason: 'closed' },
          ],
        });
      }),
    );
    mount();
    await screen.findByText('Subject 1');
    for (const n of [1, 2, 3, 4])
      await user.click(screen.getByRole('checkbox', { name: `Select ticket HD-${1000 + n}` }));
    await user.selectOptions(screen.getByLabelText('Choose an action'), 'priority');
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.click(screen.getByRole('button', { name: 'Apply to selected' }));
    const report = await screen.findByTestId('bulk-report');
    expect(sentBody?.operation).toEqual({ action: 'setPriority', priority: 'high' });
    expect(sentBody?.ids).toHaveLength(4);
    expect(report).toHaveTextContent('applied to 1, skipped 3');
    expect(report).toHaveTextContent('HD-1002');
    expect(report).toHaveTextContent('status change not allowed');
    expect(report).toHaveTextContent('no access or does not exist');
    expect(report).toHaveTextContent('the ticket is closed');
    // the applied ticket leaves the selection, the skipped ones stay selected (so the agent can act on them)
    await waitFor(() =>
      expect(screen.getByTestId('selected-count')).toHaveTextContent('3 tickets selected'),
    );
  });

  it('more than 200 selected tickets are sent in several requests and the answers are merged', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 450 }, (_, i) => ticket(100 + i));
    server.use(
      http.get(`${API}/tickets`, () => HttpResponse.json({ items: many, nextCursor: null })),
    );
    const calls: number[] = [];
    server.use(
      http.post(`${API}/tickets/bulk`, async ({ request }) => {
        const b = (await request.json()) as { ids: string[] };
        calls.push(b.ids.length);
        return HttpResponse.json({ results: b.ids.map((id) => ({ id, ok: true })) });
      }),
    );
    mount();
    await screen.findByText('Subject 100');
    await user.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
    await user.selectOptions(screen.getByLabelText('Choose an action'), 'addTags');
    await user.type(screen.getByLabelText('Tags'), 'vip');
    await user.click(screen.getByRole('button', { name: 'Apply to selected' }));
    await waitFor(
      () =>
        expect(
          calls.length > 0 || screen.queryByRole('alert') !== null,
          `calls=${calls} alert=${screen.queryByRole('alert')?.textContent}`,
        ).toBe(true),
      { timeout: 8_000 },
    );
    expect(await screen.findByTestId('bulk-report', {}, { timeout: 15_000 })).toHaveTextContent(
      'applied to 450, skipped 0',
    );
    expect(calls).toEqual([200, 200, 50]);
  }, 30_000);

  it('the apply button is disabled until an action and a value are chosen', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('Subject 1');
    await user.click(screen.getByRole('checkbox', { name: 'Select ticket HD-1001' }));
    const apply = screen.getByRole('button', { name: 'Apply to selected' });
    expect(apply).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Choose an action'), 'status');
    expect(apply).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Status'), 'resolved');
    expect(apply).toBeEnabled();
  });
});

describe('queue: live updates do not disturb the screen (acceptance: scroll and selection survive)', () => {
  it('a changed ticket is replaced in place; untouched rows are the SAME DOM nodes; selection and highlight stay', async () => {
    const user = userEvent.setup();
    const { client } = mount();
    await screen.findByText('Subject 1');
    await user.click(screen.getByRole('checkbox', { name: 'Select ticket HD-1002' }));
    await user.keyboard('jj'); // cursor on row 2
    const before = body();
    const untouched = before[3]!;
    act(() =>
      applyTicketToLists(client, {
        ...rows[1]!,
        version: 2,
        updatedAt: '2026-12-01T00:00:00Z',
        subject: 'Subject 2 (edited live)',
        status: 'pending',
      }),
    );
    expect(await screen.findByText('Subject 2 (edited live)')).toBeInTheDocument();
    const after = body();
    expect(after).toHaveLength(5);
    expect(after[3]).toBe(untouched); // not re-created: scroll position and focus are safe
    expect(after[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('checkbox', { name: 'Select ticket HD-1002' })).toBeChecked();
    expect(within(after[1]!).getByText('Waiting for customer')).toBeInTheDocument();
  });

  it('a new ticket that matches appears at its sorted place; one that stops matching the filter disappears', async () => {
    search.current = new URLSearchParams('status=open');
    const { client } = mount();
    await screen.findByText('Subject 1');
    act(() =>
      applyTicketToLists(
        client,
        ticket(9, { createdAt: '2026-11-30T10:00:00.000Z', updatedAt: '2026-11-30T10:00:00.000Z' }),
      ),
    );
    await waitFor(() => expect(body()[0]).toHaveTextContent('Subject 9')); // newest first
    act(() =>
      applyTicketToLists(client, {
        ...rows[0]!,
        version: 2,
        updatedAt: '2026-12-02T00:00:00Z',
        status: 'closed',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Subject 1')).not.toBeInTheDocument());
    expect(body()).toHaveLength(5);
  });

  it('the SLA countdown ticks and overdue rows are highlighted', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
      now: new Date('2026-11-12T10:00:00Z'),
    });
    const soon = ticket(1, { sla: { ...ticket(1).sla!, dueAt: '2026-11-12T10:30:00.000Z' } });
    server.use(
      http.get(`${API}/tickets`, () => HttpResponse.json({ items: [soon], nextCursor: null })),
    );
    mount();
    await vi.waitFor(() => expect(screen.getByText('Subject 1')).toBeInTheDocument());
    const cell = () => screen.getByTestId('sla-cell').textContent;
    expect(cell()).toMatch(/30m left|29m left/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * 60_000);
    });
    expect(cell()).toMatch(/1[89]m left/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60_000);
    });
    expect(cell()).toMatch(/overdue by/);
    expect(body()[0]!.className).toMatch(/bg-destructive/);
    vi.useRealTimers();
  });
});
