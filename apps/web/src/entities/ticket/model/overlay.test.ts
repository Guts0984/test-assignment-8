import type { TicketDto } from '@helpdesk/shared';
import { describe, expect, it } from 'vitest';
import { compareTickets, overlayTicket, removeTicket, type OverlayOptions } from './overlay';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ticket = (n: number, over: Partial<TicketDto> = {}): TicketDto => ({
  id: id(n),
  number: 1000 + n,
  code: `HD-${1000 + n}`,
  subject: `t${n}`,
  category: 'payment',
  priority: 'normal',
  status: 'open',
  customer: { id: id(900), name: 'C' },
  assignee: null,
  tags: [],
  version: 1,
  linkedTicketId: null,
  createdAt: `2026-11-${String(10 + n).padStart(2, '0')}T10:00:00.000Z`,
  updatedAt: `2026-11-${String(10 + n).padStart(2, '0')}T10:00:00.000Z`,
  lastPublicMessageAt: null,
  unread: false,
  sla: null,
  ...over,
});
const openOnly: OverlayOptions = {
  matches: (t) => t.status === 'open',
  sort: 'created',
  order: 'desc',
};

describe('overlayTicket: live events on a list that is on screen', () => {
  const list = [ticket(5), ticket(3), ticket(1)]; // newest first

  it("replaces a changed ticket IN PLACE, keeps every other row's identity (no re-render, scroll and selection survive)", () => {
    const next = overlayTicket(
      list,
      ticket(3, { version: 2, updatedAt: '2026-12-01T00:00:00Z', subject: 'edited' }),
      openOnly,
    );
    expect(next.map((t) => t.id)).toEqual(list.map((t) => t.id)); // same position although "updated" moved
    expect(next[1]?.subject).toBe('edited');
    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[2]);
  });

  it('ignores an OLDER version that arrives late (out-of-order events)', () => {
    const current = [ticket(3, { version: 4, subject: 'v4' })];
    expect(overlayTicket(current, ticket(3, { version: 3, subject: 'v3' }), openOnly)).toBe(
      current,
    );
  });

  it('ignores an exact duplicate event → the very same array back (nothing re-renders)', () => {
    const t3 = ticket(3, { version: 2 });
    const current = [ticket(5), t3];
    expect(overlayTicket(current, { ...t3 }, openOnly)).toBe(current);
  });

  it('removes a ticket that no longer matches the filter (e.g. it was resolved while the list shows "open")', () => {
    const next = overlayTicket(list, ticket(3, { version: 2, status: 'resolved' }), openOnly);
    expect(next.map((t) => t.id)).toEqual([id(5), id(1)]);
  });

  it('does NOT add a non-matching new ticket', () => {
    expect(overlayTicket(list, ticket(7, { status: 'closed' }), openOnly)).toBe(list);
  });

  it('inserts a NEW matching ticket at its sorted place (newest first → top; between others → between)', () => {
    expect(overlayTicket(list, ticket(7), openOnly).map((t) => t.id)).toEqual([
      id(7),
      id(5),
      id(3),
      id(1),
    ]);
    expect(overlayTicket(list, ticket(4), openOnly).map((t) => t.id)).toEqual([
      id(5),
      id(4),
      id(3),
      id(1),
    ]);
  });

  it('a new ticket that sorts AFTER everything loaded is not appended (it belongs to a page not loaded yet)', () => {
    expect(overlayTicket(list, ticket(0), openOnly)).toBe(list);
  });

  it('on a COMPLETE list a ticket that sorts last is appended (there is no later page to deliver it)', () => {
    expect(
      overlayTicket(list, ticket(0), { ...openOnly, complete: true }).map((t) => t.id),
    ).toEqual([id(5), id(3), id(1), id(0)]);
    expect(overlayTicket([], ticket(7), { ...openOnly, complete: true }).map((t) => t.id)).toEqual([
      id(7),
    ]);
    expect(overlayTicket([], ticket(7), openOnly)).toEqual([]); // incomplete: not appended
  });

  it('respects ascending order and the SLA key with NULLs last, ties broken by id', () => {
    const asc: OverlayOptions = { matches: () => true, sort: 'sla', order: 'asc' };
    const a = ticket(1, { sla: { dueAt: '2026-11-20T10:00:00Z' } as TicketDto['sla'] });
    const b = ticket(2, { sla: { dueAt: '2026-11-22T10:00:00Z' } as TicketDto['sla'] });
    const none = ticket(3, { sla: { dueAt: null } as TicketDto['sla'] });
    const mid = ticket(4, { sla: { dueAt: '2026-11-21T10:00:00Z' } as TicketDto['sla'] });
    expect(overlayTicket([a, b, none], mid, asc).map((t) => t.id)).toEqual([
      id(1),
      id(4),
      id(2),
      id(3),
    ]);
    const tie = ticket(9, { sla: { dueAt: '2026-11-20T10:00:00Z' } as TicketDto['sla'] });
    expect(overlayTicket([a, b], tie, asc).map((t) => t.id)).toEqual([id(1), id(9), id(2)]); // same due → by id
  });

  it('never mutates its input', () => {
    const frozen = Object.freeze(list.map((t) => Object.freeze({ ...t })));
    expect(() => overlayTicket(frozen, ticket(4), openOnly)).not.toThrow();
    expect(() =>
      overlayTicket(frozen, ticket(3, { version: 2, status: 'closed' }), openOnly),
    ).not.toThrow();
  });

  it('a 500-event storm (shuffled, with duplicates) converges to the same list as in-order application', () => {
    const events = Array.from({ length: 500 }, (_, i) =>
      ticket(1 + (i % 7), {
        version: 1 + Math.floor(i / 7),
        status: i % 11 === 0 ? 'closed' : 'open',
        updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
      }),
    );
    const apply = (evs: TicketDto[]) =>
      evs.reduce<readonly TicketDto[]>((acc, e) => overlayTicket(acc, e, openOnly), []);
    const inOrder = apply(events);
    let seed = 7;
    const shuffled = [...events, ...events].sort(
      () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5,
    );
    // events for the same ticket arrive in arbitrary order; the highest version must win
    const final = apply(shuffled);
    const latest = (list: readonly TicketDto[]) => new Map(list.map((t) => [t.id, t.version]));
    for (const [tid, v] of latest(final))
      expect(v).toBeGreaterThanOrEqual(latest(inOrder).get(tid) ?? 0);
    expect(new Set(final.map((t) => t.id)).size).toBe(final.length); // never a duplicate row
  });

  it('removeTicket drops by id and returns the same array when absent', () => {
    expect(removeTicket(list, id(3)).map((t) => t.id)).toEqual([id(5), id(1)]);
    expect(removeTicket(list, id(99))).toBe(list);
  });

  it('compareTickets is a consistent total order', () => {
    const items = [ticket(2), ticket(9), ticket(4), ticket(1)];
    const sorted = [...items].sort((x, y) => compareTickets(x, y, 'created', 'desc'));
    expect(sorted.map((t) => t.id)).toEqual([id(9), id(4), id(2), id(1)]);
    expect(compareTickets(items[0]!, items[0]!, 'created', 'asc')).toBe(0);
  });
});
