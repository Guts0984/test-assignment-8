import { canTransition, type PatchTicketInput } from '@helpdesk/shared';
import type { SessionUser } from '../lib/sessions';
import type { Changes } from './mutate';
import type { TicketRow } from './model';

export type Denied = {
  status: 400 | 403 | 409;
  code: 'forbidden' | 'invalid_transition' | 'validation_error';
  message: string;
  /** Bulk-report reason */
  reason: 'not_found_or_forbidden' | 'invalid_transition' | 'closed' | 'assignee_not_eligible';
};

/**
 * Who may change what (pure; the caller has already established that the user can SEE the ticket).
 *  customer — only "problem solved" (→ resolved) on their own ticket;
 *  agent    — status, priority, tags; may take an unassigned ticket or release their own; not category, not others' tickets;
 *  lead     — everything.
 * `assigneeIsEligible` is the caller's lookup (target must be an active agent).
 */
export const authorizeChanges = (
  user: SessionUser,
  row: TicketRow,
  c: Changes,
  assigneeIsEligible: boolean,
): Denied | null => {
  const deny = (d: Denied): Denied => d;
  if (row.status === 'closed') {
    return deny({
      status: 409,
      code: 'invalid_transition',
      message: 'A closed ticket cannot be changed',
      reason: 'closed',
    });
  }
  if (user.role === 'customer') {
    if (
      c.priority !== undefined ||
      c.category !== undefined ||
      c.assigneeId !== undefined ||
      c.tags !== undefined
    ) {
      return deny({
        status: 403,
        code: 'forbidden',
        message: 'Customers may only mark their ticket as solved',
        reason: 'not_found_or_forbidden',
      });
    }
  } else if (user.role === 'agent') {
    if (c.category !== undefined && c.category !== row.category) {
      return deny({
        status: 403,
        code: 'forbidden',
        message: 'Only a lead can change the category',
        reason: 'not_found_or_forbidden',
      });
    }
    if (c.assigneeId !== undefined && c.assigneeId !== row.assignee_id) {
      const takingFree = c.assigneeId === user.id && row.assignee_id === null;
      const releasing = c.assigneeId === null && row.assignee_id === user.id;
      if (!takingFree && !releasing) {
        return deny({
          status: 403,
          code: 'forbidden',
          message: 'Agents can only take a free ticket or release their own',
          reason: 'not_found_or_forbidden',
        });
      }
    }
  }
  if (
    c.status !== undefined &&
    c.status !== row.status &&
    !canTransition(row.status, c.status, user.role)
  ) {
    return deny({
      status: 409,
      code: 'invalid_transition',
      message: `Cannot change status from ${row.status} to ${c.status}`,
      reason: 'invalid_transition',
    });
  }
  if (
    user.role === 'lead' &&
    typeof c.assigneeId === 'string' &&
    c.assigneeId !== row.assignee_id &&
    !assigneeIsEligible
  ) {
    return deny({
      status: 400,
      code: 'validation_error',
      message: 'The assignee must be an active agent',
      reason: 'assignee_not_eligible',
    });
  }
  return null;
};

export const toChanges = (p: PatchTicketInput): Changes => ({
  ...(p.status !== undefined ? { status: p.status } : {}),
  ...(p.priority !== undefined ? { priority: p.priority } : {}),
  ...(p.category !== undefined ? { category: p.category } : {}),
  ...(p.assigneeId !== undefined ? { assigneeId: p.assigneeId } : {}),
  ...(p.tags !== undefined ? { tags: p.tags } : {}),
});
