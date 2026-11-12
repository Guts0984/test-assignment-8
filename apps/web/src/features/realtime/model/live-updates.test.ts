import { QueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API, envelope, http, HttpResponse, server } from '../../../../test/utils';
import { ticket, uid } from '../../../../test/fixtures';
import { DEFAULT_FILTERS } from '@/entities/ticket/model/filters';
import { ticketKeys } from '@/entities/ticket/api/tickets';
import type { TicketPages } from '@/entities/ticket/model/pages';
import { handleLiveEvent } from './live-updates';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ME = uid(500);
const listData = (...n: number[]): TicketPages => ({
  pageParams: [undefined],
  pages: [{ items: n.map((i) => ticket(i)), nextCursor: null }],
});
const setup = () => {
  const qc = new QueryClient();
  qc.setQueryData(ticketKeys.list(DEFAULT_FILTERS, ME), listData(1, 2));
  qc.setQueryData(ticketKeys.list({ ...DEFAULT_FILTERS, status: ['closed'] }, ME), listData());
  qc.setQueryData(ticketKeys.list({ ...DEFAULT_FILTERS, q: 'refund' }, ME), listData(1));
  const announce = vi.fn();
  const hooks = {
    meId: ME,
    announce,
    describe: (e: { type: string }) =>
      e.type === 'message.created'
        ? 'new reply'
        : e.type === 'notification.created'
          ? 'bell'
          : null,
  };
  return { qc, announce, hooks };
};
const detailOf = (t: ReturnType<typeof ticket>) =>
  HttpResponse.json({ ticket: t, messages: [], events: [], rating: null });

describe('handleLiveEvent', () => {
  it('ticket.changed: fetches the ticket once, updates the open detail and patches EVERY cached list it belongs to', async () => {
    const { qc, hooks } = setup();
    let fetches = 0;
    const changed = ticket(2, { version: 2, status: 'closed', updatedAt: '2026-12-01T00:00:00Z' });
    server.use(
      http.get(`${API}/tickets/${uid(2)}`, () => {
        fetches += 1;
        return detailOf(changed);
      }),
    );
    await handleLiveEvent(
      qc,
      { type: 'ticket.changed', ticketId: uid(2), version: 2, changed: ['status'] },
      hooks,
    );
    expect(fetches).toBe(1);
    expect(
      (qc.getQueryData(ticketKeys.detail(uid(2))) as { ticket: { status: string } }).ticket.status,
    ).toBe('closed');
    const all = qc.getQueryData<TicketPages>(ticketKeys.list(DEFAULT_FILTERS, ME))!.pages[0]!.items;
    expect(all.find((t) => t.id === uid(2))?.status).toBe('closed'); // updated in place in the unfiltered list
    const closed = qc.getQueryData<TicketPages>(
      ticketKeys.list({ ...DEFAULT_FILTERS, status: ['closed'] }, ME),
    )!.pages[0]!.items;
    expect(closed.map((t) => t.id)).toEqual([uid(2)]); // and it now appears in the "closed" list
  });

  it('a list with a text search is refetched, not patched (the client cannot evaluate a full-text match)', async () => {
    const { qc, hooks } = setup();
    server.use(http.get(`${API}/tickets/${uid(2)}`, () => detailOf(ticket(2, { version: 2 }))));
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await handleLiveEvent(
      qc,
      { type: 'ticket.changed', ticketId: uid(2), version: 2, changed: ['status'] },
      hooks,
    );
    expect(spy).toHaveBeenCalledWith({
      queryKey: ticketKeys.list({ ...DEFAULT_FILTERS, q: 'refund' }, ME),
    });
  });

  it('a 404 (access lost / gone) removes the ticket from every list and drops its detail', async () => {
    const { qc, hooks } = setup();
    qc.setQueryData(ticketKeys.detail(uid(1)), { ticket: ticket(1) });
    server.use(http.get(`${API}/tickets/${uid(1)}`, () => envelope(404, 'not_found', 'x')));
    await handleLiveEvent(
      qc,
      { type: 'ticket.changed', ticketId: uid(1), version: 3, changed: ['category'] },
      hooks,
    );
    expect(
      qc
        .getQueryData<TicketPages>(ticketKeys.list(DEFAULT_FILTERS, ME))!
        .pages[0]!.items.map((t) => t.id),
    ).toEqual([uid(2)]);
    expect(qc.getQueryData(ticketKeys.detail(uid(1)))).toBeUndefined();
  });

  it('a server error during the fetch refetches the lists instead of corrupting them', async () => {
    const { qc, hooks } = setup();
    const before = qc.getQueryData(ticketKeys.list(DEFAULT_FILTERS, ME));
    server.use(http.get(`${API}/tickets/${uid(2)}`, () => envelope(503, 'service_unavailable')));
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await handleLiveEvent(qc, { type: 'ticket.created', ticketId: uid(2) }, hooks);
    expect(spy).toHaveBeenCalledWith({ queryKey: ticketKeys.lists });
    expect(qc.getQueryData(ticketKeys.list(DEFAULT_FILTERS, ME))).toBe(before);
  });

  it('message.created (a reply that changes NO field, so no ticket.changed follows) still refreshes the open conversation AND the lists, and announces; notification.created refreshes the bell and announces', async () => {
    const { qc, announce, hooks } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const replied = ticket(1, { version: 5, updatedAt: '2026-12-02T00:00:00Z' });
    server.use(http.get(`${API}/tickets/${uid(1)}`, () => detailOf(replied)));
    await handleLiveEvent(
      qc,
      { type: 'message.created', ticketId: uid(1), messageId: uid(9), kind: 'public' },
      hooks,
    );
    expect(
      (qc.getQueryData(ticketKeys.detail(uid(1))) as { ticket: { version: number } }).ticket
        .version,
    ).toBe(5);
    const inList = qc
      .getQueryData<TicketPages>(ticketKeys.list(DEFAULT_FILTERS, ME))!
      .pages[0]!.items.find((t) => t.id === uid(1));
    expect(inList?.updatedAt).toBe('2026-12-02T00:00:00Z'); // the "Updated" column / unread mark follows without a reload
    expect(announce).toHaveBeenCalledWith('new reply');
    await handleLiveEvent(
      qc,
      {
        type: 'notification.created',
        notificationId: uid(8),
        kind: 'assigned',
        ticketId: uid(1),
        number: 'HD-1',
      },
      hooks,
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['notifications'] });
    expect(announce).toHaveBeenCalledWith('bell');
  });

  it('presence of someone else refreshes the "now replying" indicator; my own presence is ignored', async () => {
    const { qc, hooks } = setup();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await handleLiveEvent(
      qc,
      { type: 'presence', ticketId: uid(1), userId: ME, name: 'me', typing: true },
      hooks,
    );
    expect(spy).not.toHaveBeenCalled();
    await handleLiveEvent(
      qc,
      { type: 'presence', ticketId: uid(1), userId: uid(7), name: 'Петро', typing: true },
      hooks,
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['presence', uid(1)] });
  });
});
