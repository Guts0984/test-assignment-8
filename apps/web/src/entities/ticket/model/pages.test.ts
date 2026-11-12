import { describe, expect, it } from 'vitest';
import { ticket, uid } from '../../../../test/fixtures';
import { overlayPages, removeFromPages, type TicketPages } from './pages';
import type { OverlayOptions } from './overlay';

const opts: OverlayOptions = { matches: () => true, sort: 'created', order: 'desc' };
const pages = (...groups: number[][]): TicketPages => ({
  pageParams: groups.map((_, i) => (i === 0 ? undefined : `c${i}`)),
  pages: groups.map((g, i) => ({
    items: g.map((n) =>
      ticket(n, {
        createdAt: `2026-11-${String(30 - n).padStart(2, '0')}T10:00:00.000Z`,
        updatedAt: `2026-11-${String(30 - n).padStart(2, '0')}T10:00:00.000Z`,
      }),
    ),
    nextCursor: i < groups.length - 1 ? `c${i + 1}` : null,
  })),
});

describe('overlayPages (several loaded pages)', () => {
  it('a changed ticket is replaced inside ITS page; other pages keep their identity', () => {
    const d = pages([1, 2], [3, 4], [5, 6]);
    const next = overlayPages(
      d,
      {
        ...d.pages[1]!.items[0]!,
        version: 2,
        updatedAt: '2026-12-01T00:00:00Z',
        subject: 'changed',
      },
      opts,
    );
    expect(next.pages[1]!.items[0]!.subject).toBe('changed');
    expect(next.pages[0]).toBe(d.pages[0]);
    expect(next.pages[2]).toBe(d.pages[2]);
    expect(next.pageParams).toBe(d.pageParams);
  });
  it('a duplicate or stale event returns the very same object (no re-render)', () => {
    const d = pages([1, 2], [3]);
    expect(overlayPages(d, d.pages[0]!.items[1]!, opts)).toBe(d);
    expect(overlayPages(d, { ...d.pages[0]!.items[0]!, version: 0 }, opts)).toBe(d);
  });
  it('a new newest ticket joins the FIRST page; the cursors are kept', () => {
    const d = pages([2, 3], [4, 5]);
    const next = overlayPages(
      d,
      ticket(1, { createdAt: '2026-11-29T10:00:00.000Z', updatedAt: '2026-11-29T10:00:00.000Z' }),
      opts,
    );
    expect(next.pages[0]!.items.map((t) => t.id)).toEqual([uid(1), uid(2), uid(3)]);
    expect(next.pages[1]).toBe(d.pages[1]);
    expect(next.pages.map((p) => p.nextCursor)).toEqual(['c1', null]);
  });
  it('a new ticket that belongs between two pages goes to the page of the row it follows', () => {
    const d = pages([1, 2], [4, 5]);
    const next = overlayPages(
      d,
      ticket(3, { createdAt: '2026-11-27T10:00:00.000Z', updatedAt: '2026-11-27T10:00:00.000Z' }),
      opts,
    );
    expect(next.pages.flatMap((p) => p.items).map((t) => t.id)).toEqual([
      uid(1),
      uid(2),
      uid(3),
      uid(4),
      uid(5),
    ]);
  });
  it('a ticket that no longer matches is removed from its page', () => {
    const d = pages([1, 2], [3]);
    const next = overlayPages(
      d,
      { ...d.pages[0]!.items[0]!, version: 2, updatedAt: '2026-12-01T00:00:00Z', status: 'closed' },
      { ...opts, matches: (t) => t.status === 'open' },
    );
    expect(next.pages[0]!.items.map((t) => t.id)).toEqual([uid(2)]);
    expect(next.pages[1]).toBe(d.pages[1]);
  });
  it('removeFromPages drops by id and is a no-op for unknown ids', () => {
    const d = pages([1, 2], [3]);
    expect(removeFromPages(d, uid(3)).pages[1]!.items).toEqual([]);
    expect(removeFromPages(d, uid(99))).toBe(d);
  });
});
