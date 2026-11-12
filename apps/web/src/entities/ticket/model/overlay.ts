import type { TicketDto } from '@helpdesk/shared';

export type SortKey = 'sla' | 'created' | 'updated';
export type Order = 'asc' | 'desc';

export type OverlayOptions = {
  /** Does this ticket belong in the current list (filters)? */
  matches: (t: TicketDto) => boolean;
  sort: SortKey;
  order: Order;
  /** Every page of this list is loaded (no further cursor): a ticket that sorts last is appended instead of left to a later page. */
  complete?: boolean;
};

const keyOf = (t: TicketDto, sort: SortKey): string | null =>
  sort === 'sla' ? (t.sla?.dueAt ?? null) : sort === 'created' ? t.createdAt : t.updatedAt;

/** Same ordering as the API: by key (NULLs last), ties by id, both in the requested direction. */
export const compareTickets = (a: TicketDto, b: TicketDto, sort: SortKey, order: Order): number => {
  const ka = keyOf(a, sort);
  const kb = keyOf(b, sort);
  const dir = order === 'asc' ? 1 : -1;
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka < kb ? -dir : dir;
  }
  return a.id < b.id ? -dir : a.id > b.id ? dir : 0;
};

/**
 * Overlays one fresh ticket onto a list that is already on screen. Pure and referentially careful:
 *  - an OLDER version than we hold is ignored (events can arrive out of order) → same array back;
 *  - an identical repeat is ignored (duplicate event) → same array back;
 *  - a ticket that no longer matches the filters is removed; a matching one is replaced IN PLACE (position kept, so
 *    scroll position and the user's selection are not disturbed) or, if new, inserted at its sorted place;
 *  - every untouched row keeps its object identity, so React does not re-render or remount it.
 */
export const overlayTicket = (
  items: readonly TicketDto[],
  incoming: TicketDto,
  opts: OverlayOptions,
): readonly TicketDto[] => {
  const index = items.findIndex((t) => t.id === incoming.id);
  const existing = index === -1 ? undefined : items[index];
  if (
    existing &&
    (incoming.version < existing.version ||
      (incoming.version === existing.version && incoming.updatedAt <= existing.updatedAt))
  )
    return items;

  if (!opts.matches(incoming)) return existing ? items.filter((t) => t.id !== incoming.id) : items;

  if (existing) return items.map((t, i) => (i === index ? incoming : t));

  // new ticket: insert where the API ordering would put it. If it sorts after everything we hold it may belong to a page
  // we have not loaded yet, so it is NOT appended (the next page will deliver it).
  const at = items.findIndex((t) => compareTickets(incoming, t, opts.sort, opts.order) < 0);
  if (at === -1) return opts.complete ? [...items, incoming] : items;
  return [...items.slice(0, at), incoming, ...items.slice(at)];
};

/** Removes a ticket (e.g. access lost). */
export const removeTicket = (items: readonly TicketDto[], id: string): readonly TicketDto[] =>
  items.some((t) => t.id === id) ? items.filter((t) => t.id !== id) : items;
