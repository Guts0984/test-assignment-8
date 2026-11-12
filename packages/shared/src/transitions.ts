import type { MessageKind, Role, TicketStatus } from './enums';
import { STATUSES } from './enums';

/**
 * Manually requested status transitions per actor role.
 * (Automatic ones — reply-driven and the auto-close job — are in `statusAfterMessage` / `AUTO_CLOSE`.)
 * Documented as a table in README.
 */
const STAFF_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  new: ['open', 'pending', 'resolved'],
  open: ['pending', 'resolved'],
  pending: ['open', 'resolved'],
  resolved: ['open', 'closed'],
  closed: [],
};

const CUSTOMER_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  new: ['resolved'],
  open: ['resolved'],
  pending: ['resolved'],
  resolved: [],
  closed: [],
};

export const transitionTable = (role: Role) =>
  role === 'customer' ? CUSTOMER_TRANSITIONS : STAFF_TRANSITIONS;

export const canTransition = (from: TicketStatus, to: TicketStatus, role: Role): boolean =>
  transitionTable(role)[from].includes(to);

export const allowedTransitions = (from: TicketStatus, role: Role): readonly TicketStatus[] =>
  transitionTable(role)[from];

/** Resolved tickets with no customer reply for this long are closed by a background job. */
export const AUTO_CLOSE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export type MessageOutcome =
  | { type: 'keep' }
  | { type: 'set'; status: TicketStatus }
  /** Customer replied to a closed ticket: create a new ticket that links to this one. */
  | { type: 'spawn-linked-ticket' }
  | { type: 'reject'; reason: 'closed_ticket_staff_reply' | 'internal_note_by_customer' };

/** Status effect of posting a message. Pure; the caller persists the result. */
export const statusAfterMessage = (input: {
  status: TicketStatus;
  authorRole: Role;
  kind: MessageKind;
}): MessageOutcome => {
  const { status, authorRole, kind } = input;
  if (authorRole === 'customer') {
    if (kind === 'internal') return { type: 'reject', reason: 'internal_note_by_customer' };
    if (status === 'closed') return { type: 'spawn-linked-ticket' };
    if (status === 'pending' || status === 'resolved') return { type: 'set', status: 'open' };
    return { type: 'keep' };
  }
  if (status === 'closed') return { type: 'reject', reason: 'closed_ticket_staff_reply' };
  if (kind === 'internal') return { type: 'keep' };
  if (status === 'new' || status === 'pending') return { type: 'set', status: 'open' };
  return { type: 'keep' };
};

export const isTerminal = (status: TicketStatus): boolean => status === 'closed';

/** Statuses during which the SLA clock runs. `pending` pauses it; `resolved`/`closed` stop it. */
export const slaClockRunning = (status: TicketStatus): boolean =>
  status === 'new' || status === 'open';

export const ALL_STATUS_PAIRS: ReadonlyArray<readonly [TicketStatus, TicketStatus]> =
  STATUSES.flatMap((a) => STATUSES.map((b) => [a, b] as const));
