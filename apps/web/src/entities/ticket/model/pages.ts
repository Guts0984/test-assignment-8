import type { TicketDto, TicketList } from '@helpdesk/shared';
import { overlayTicket, removeTicket, type OverlayOptions } from './overlay';

export type TicketPages = { pages: TicketList[]; pageParams: unknown[] };

/**
 * Applies one fresh ticket to an infinite-query result (several loaded pages). Items keep their page; a NEW ticket joins the
 * page of the row it sorts after (or the first page, at the top). Untouched pages keep their identity.
 */
export const overlayPages = (
  data: TicketPages,
  incoming: TicketDto,
  opts: OverlayOptions,
): TicketPages => {
  const flat = data.pages.flatMap((p) => p.items);
  const complete =
    data.pages.length === 0 || data.pages[data.pages.length - 1]?.nextCursor === null;
  const next = overlayTicket(flat, incoming, { ...opts, complete });
  if (next === flat || (next.length === flat.length && next.every((t, i) => t === flat[i])))
    return data;
  const pageOf = new Map<string, number>();
  data.pages.forEach((p, i) => p.items.forEach((t) => pageOf.set(t.id, i)));
  const buckets: TicketDto[][] = data.pages.map(() => []);
  let current = 0;
  for (const t of next) {
    const page = pageOf.get(t.id);
    if (page !== undefined) current = page;
    buckets[current]?.push(t);
  }
  return {
    ...data,
    pages: data.pages.map((p, i) =>
      sameItems(p.items, buckets[i] ?? []) ? p : { ...p, items: buckets[i] ?? [] },
    ),
  };
};

export const removeFromPages = (data: TicketPages, id: string): TicketPages => {
  let changed = false;
  const pages = data.pages.map((p) => {
    const items = removeTicket(p.items, id);
    if (items === p.items) return p;
    changed = true;
    return { ...p, items: [...items] };
  });
  return changed ? { ...data, pages } : data;
};

const sameItems = (a: readonly TicketDto[], b: readonly TicketDto[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);
