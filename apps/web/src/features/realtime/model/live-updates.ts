import type { QueryClient } from '@tanstack/react-query';
import type { SseEvent, TicketDto } from '@helpdesk/shared';
import {
  cachedLists,
  fetchTicketDetail,
  filtersOfKey,
  ticketKeys,
} from '@/entities/ticket/api/tickets';
import { overlayPages, removeFromPages } from '@/entities/ticket/model/pages';
import { ticketMatches } from '@/entities/ticket/model/filters';
import { isApiError } from '@/shared/api/client';

/** Puts a fresh ticket into every cached list it belongs in (and takes it out of those it no longer matches). */
export const applyTicketToLists = (qc: QueryClient, ticket: TicketDto): void => {
  for (const [key, data] of cachedLists(qc)) {
    if (!data) continue;
    const { filters, meId } = filtersOfKey(key);
    // a text search cannot be evaluated here: leave such lists to a refetch instead of guessing
    if (filters.q.trim() !== '') {
      void qc.invalidateQueries({ queryKey: key });
      continue;
    }
    qc.setQueryData(
      key,
      overlayPages(data, ticket, {
        matches: (t) => ticketMatches(filters, t, meId),
        sort: filters.sort,
        order: filters.order,
      }),
    );
  }
};

export type LiveHooks = {
  announce: (message: string) => void;
  /** localised text for an event worth announcing, or null */
  describe: (e: SseEvent) => string | null;
  meId: string;
};

/**
 * Reacts to one server event. Events carry only ids, so the fresh ticket is fetched (the server applies the viewer's
 * permissions) and then overlaid onto whatever lists are on screen — no refetch of the lists, no scroll reset.
 */
export const handleLiveEvent = async (
  qc: QueryClient,
  e: SseEvent,
  hooks: LiveHooks,
): Promise<void> => {
  switch (e.type) {
    case 'ticket.created':
    case 'ticket.changed': {
      try {
        const detail = await fetchTicketDetail(e.ticketId);
        qc.setQueryData(ticketKeys.detail(e.ticketId), detail);
        applyTicketToLists(qc, detail.ticket);
      } catch (err) {
        // 404 = we lost access (or it vanished): drop it everywhere; other errors: a refetch will reconcile
        if (isApiError(err) && err.info.status === 404) {
          qc.removeQueries({ queryKey: ticketKeys.detail(e.ticketId) });
          for (const [key, data] of cachedLists(qc))
            if (data) qc.setQueryData(key, removeFromPages(data, e.ticketId));
        } else void qc.invalidateQueries({ queryKey: ticketKeys.lists });
      }
      return;
    }
    case 'message.created': {
      await qc.invalidateQueries({ queryKey: ticketKeys.detail(e.ticketId) });
      const text = hooks.describe(e);
      if (text) hooks.announce(text);
      return;
    }
    case 'notification.created': {
      await qc.invalidateQueries({ queryKey: ['notifications'] });
      const text = hooks.describe(e);
      if (text) hooks.announce(text);
      return;
    }
    case 'presence': {
      if (e.userId !== hooks.meId)
        void qc.invalidateQueries({ queryKey: ['presence', e.ticketId] });
      return;
    }
  }
};
