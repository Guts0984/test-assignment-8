import type { MessageDto, TicketEventDto } from '@helpdesk/shared';

export type TimelineItem =
  | { kind: 'message'; at: string; id: string; message: MessageDto }
  | { kind: 'event'; at: string; id: string; event: TicketEventDto };

/**
 * Messages, internal notes and field changes in ONE chronological list. Ties keep a stable order
 * (messages before the change they caused, otherwise by id) so the list never jitters between refreshes.
 * The "created" event is dropped: the first message already says it.
 */
export const buildTimeline = (
  messages: readonly MessageDto[],
  events: readonly TicketEventDto[],
): TimelineItem[] => {
  const items: TimelineItem[] = [
    ...messages.map(
      (m): TimelineItem => ({ kind: 'message', at: m.createdAt, id: m.id, message: m }),
    ),
    ...events
      .filter((e) => e.field !== 'created')
      .map(
        (e): TimelineItem => ({
          kind: 'event',
          at: e.createdAt,
          id: String(e.id).padStart(12, '0'),
          event: e,
        }),
      ),
  ];
  return items.sort((a, b) =>
    a.at < b.at
      ? -1
      : a.at > b.at
        ? 1
        : a.kind !== b.kind
          ? a.kind === 'message'
            ? -1
            : 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
  );
};

/** Messages written by someone else that were not on screen before — the ones worth announcing. */
export const newForeignMessages = (
  previousIds: ReadonlySet<string>,
  messages: readonly MessageDto[],
  meId: string,
): MessageDto[] => messages.filter((m) => !previousIds.has(m.id) && m.author.id !== meId);
