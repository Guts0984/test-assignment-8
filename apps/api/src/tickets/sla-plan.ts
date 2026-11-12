import {
  addSlaMinutes,
  computeDeadlines,
  remainingSlaMinutes,
  resumeDeadline,
  type Priority,
  type SlaPolicy,
  type TicketStatus,
} from '@helpdesk/shared';
import type { TicketRow } from './model';

export type Policies = Readonly<Record<Priority, SlaPolicy>>;

/** Column updates (snake_case) a planner wants applied. `undefined` = leave alone, `null` = set NULL. */
export type SlaUpdate = Partial<{
  first_response_due: Date;
  resolution_due: Date;
  resolved_at: Date | null;
  closed_at: Date | null;
  first_responded_at: Date | null;
  sla_paused_at: Date | null;
  first_response_remaining_min: number | null;
  resolution_remaining_min: number | null;
  first_response_warned_at: Date | null;
  resolution_warned_at: Date | null;
  first_response_breached_at: Date | null;
  resolution_breached_at: Date | null;
}>;

const WARN_BEFORE_MS = 30 * 60_000;

/**
 * SLA consequences of a status change (pure). Rules:
 *  - entering `pending` stops the clock and stores the minutes left on each open deadline;
 *  - leaving `pending` for `open` restarts it: new deadline = now + remaining (business time for business policies);
 *  - `resolved` stamps resolved_at; reopening (resolved → open) clears it and grants a fresh resolution window
 *    (never shorter than what was left), and forgets the old resolution breach/warning;
 *  - `closed` stamps closed_at.
 */
export const planStatusChange = (
  t: TicketRow,
  to: TicketStatus,
  now: Date,
  policies: Policies,
): SlaUpdate => {
  const from = t.status;
  const policy = policies[t.priority];
  const u: SlaUpdate = {};

  if (to === 'pending' && from !== 'pending') {
    u.sla_paused_at = now;
    u.first_response_remaining_min =
      t.first_responded_at === null
        ? remainingSlaMinutes(now, t.first_response_due, policy.businessHours)
        : null;
    u.resolution_remaining_min = remainingSlaMinutes(now, t.resolution_due, policy.businessHours);
  }

  if (from === 'pending' && to !== 'pending') {
    u.sla_paused_at = null;
    u.first_response_remaining_min = null;
    u.resolution_remaining_min = null;
    if (to === 'open' || to === 'new') {
      const firstDue =
        t.first_response_remaining_min !== null && t.first_responded_at === null
          ? resumeDeadline(now, t.first_response_remaining_min, policy.businessHours)
          : t.first_response_due;
      let resDue =
        t.resolution_remaining_min !== null
          ? resumeDeadline(now, t.resolution_remaining_min, policy.businessHours)
          : t.resolution_due;
      if (resDue.getTime() < firstDue.getTime()) resDue = firstDue;
      u.first_response_due = firstDue;
      u.resolution_due = resDue;
    }
  }

  if (to === 'resolved') u.resolved_at = now;
  if (to === 'closed') u.closed_at = now;

  if (from === 'resolved' && (to === 'open' || to === 'new')) {
    u.resolved_at = null;
    const fresh = addSlaMinutes(now, policy.resolutionMinutes, policy.businessHours);
    const base = u.first_response_due ?? t.first_response_due;
    const keep = t.resolution_due.getTime() > fresh.getTime() ? t.resolution_due : fresh;
    u.resolution_due = keep.getTime() < base.getTime() ? base : keep;
    u.resolution_breached_at = null;
    u.resolution_warned_at = null;
  }
  return u;
};

/**
 * Changing priority recomputes BOTH deadlines from the moment of creation with the new policy
 * (assignment rule), then re-derives the warned/breached marks so they match the new deadlines.
 * If the ticket is paused the stored remaining minutes are recomputed against the pause instant.
 */
export const planPriorityChange = (t: TicketRow, to: SlaPolicy, now: Date): SlaUpdate => {
  const { firstResponseDue, resolutionDue } = computeDeadlines(t.created_at, to);
  const clock = t.sla_paused_at ?? now;
  const breachMark = (due: Date, doneAt: Date | null, existing: Date | null): Date | null =>
    (doneAt ?? clock).getTime() > due.getTime() && due.getTime() <= now.getTime()
      ? (existing ?? due)
      : null;
  const warnMark = (due: Date, doneAt: Date | null, existing: Date | null): Date | null => {
    const at = new Date(due.getTime() - WARN_BEFORE_MS);
    return (doneAt ?? clock).getTime() >= at.getTime() && at.getTime() <= now.getTime()
      ? (existing ?? at)
      : null;
  };
  const u: SlaUpdate = {
    first_response_due: firstResponseDue,
    resolution_due: resolutionDue,
    first_response_breached_at: breachMark(
      firstResponseDue,
      t.first_responded_at,
      t.first_response_breached_at,
    ),
    resolution_breached_at: breachMark(resolutionDue, t.resolved_at, t.resolution_breached_at),
    first_response_warned_at: warnMark(
      firstResponseDue,
      t.first_responded_at,
      t.first_response_warned_at,
    ),
    resolution_warned_at: warnMark(resolutionDue, t.resolved_at, t.resolution_warned_at),
  };
  if (t.sla_paused_at) {
    u.first_response_remaining_min =
      t.first_responded_at === null
        ? remainingSlaMinutes(t.sla_paused_at, firstResponseDue, to.businessHours)
        : null;
    u.resolution_remaining_min = remainingSlaMinutes(
      t.sla_paused_at,
      resolutionDue,
      to.businessHours,
    );
  }
  return u;
};
