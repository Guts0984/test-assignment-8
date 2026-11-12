/** Fields recorded in a ticket's history. */
export const ticketEventFieldValues = [
  'created',
  'status',
  'priority',
  'assignee',
  'category',
  'tags',
] as const;
export type TicketEventField = (typeof ticketEventFieldValues)[number];
