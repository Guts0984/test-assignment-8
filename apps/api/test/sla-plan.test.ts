import {
  DEFAULT_SLA_POLICIES,
  businessMinutesBetween,
  computeDeadlines,
  type Priority,
  type TicketStatus,
} from '@helpdesk/shared';
import { describe, expect, it } from 'vitest';
import type { TicketRow } from '../src/tickets/model';
import { planPriorityChange, planStatusChange } from '../src/tickets/sla-plan';

const at = (s: string) => new Date(s);
const iso = (d: Date | null | undefined) => d?.toISOString();
// Winter: Kyiv = UTC+2. 2026-11-13 is a Friday.
const FRI_17_00 = at('2026-11-13T15:00:00Z');

const ticket = (priority: Priority, createdAt: Date, over: Partial<TicketRow> = {}): TicketRow => {
  const d = computeDeadlines(createdAt, DEFAULT_SLA_POLICIES[priority]);
  return {
    id: 'x',
    number: 1001,
    subject: 's',
    category: 'payment',
    priority,
    status: 'new',
    customer_id: 'c',
    assignee_id: null,
    tags: [],
    version: 1,
    linked_ticket_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    last_public_message_at: createdAt,
    first_response_due: d.firstResponseDue,
    resolution_due: d.resolutionDue,
    first_responded_at: null,
    resolved_at: null,
    closed_at: null,
    sla_paused_at: null,
    first_response_remaining_min: null,
    resolution_remaining_min: null,
    first_response_warned_at: null,
    resolution_warned_at: null,
    first_response_breached_at: null,
    resolution_breached_at: null,
    sla_due_at: d.firstResponseDue,
    customer_name: 'C',
    assignee_name: null,
    unread: false,
    ...over,
  };
};
const apply = (t: TicketRow, status: TicketStatus, now: Date): TicketRow => ({
  ...t,
  ...planStatusChange(t, status, now, DEFAULT_SLA_POLICIES),
  status,
});

describe('SLA: deadlines on creation (assignment acceptance #10)', () => {
  it('high priority created Friday 17:00 Kyiv → first reply Monday 12:00, resolution Monday 17:00', () => {
    const t = ticket('high', FRI_17_00);
    expect(iso(t.first_response_due)).toBe('2026-11-16T10:00:00.000Z'); // Mon 12:00 Kyiv
    expect(iso(t.resolution_due)).toBe('2026-11-16T15:00:00.000Z'); // Mon 17:00 Kyiv
  });
});

describe('pause in `pending` (the clock stops, restarts with what was left)', () => {
  it('entering pending stores the remaining business minutes and the pause time', () => {
    const t = ticket('high', FRI_17_00, {
      status: 'open',
      first_responded_at: at('2026-11-13T15:30:00Z'),
    });
    const p = apply(t, 'pending', at('2026-11-13T15:30:00Z')); // Fri 17:30
    expect(iso(p.sla_paused_at)).toBe('2026-11-13T15:30:00.000Z');
    expect(p.first_response_remaining_min).toBeNull(); // already answered → nothing left on that clock
    expect(p.resolution_remaining_min).toBe(30 + 480); // 30 min left Friday + Monday 9:00-17:00
  });
  it('a long wait (a whole week) does NOT eat the deadline; resuming gives back exactly the remaining time', () => {
    const t = ticket('high', FRI_17_00, {
      status: 'open',
      first_responded_at: at('2026-11-13T15:30:00Z'),
    });
    const paused = apply(t, 'pending', at('2026-11-13T15:30:00Z'));
    const resumedAt = at('2026-11-23T08:00:00Z'); // Monday a week and a half later, 10:00 Kyiv
    const open = apply(paused, 'open', resumedAt);
    expect(open.sla_paused_at).toBeNull();
    expect(open.resolution_remaining_min).toBeNull();
    expect(businessMinutesBetween(resumedAt, open.resolution_due)).toBe(510);
    // Mon 10:00 → 18:00 uses 480 of the 510; the last 30 fall on Tuesday 09:00–09:30 Kyiv
    expect(iso(open.resolution_due)).toBe('2026-11-24T07:30:00.000Z');
  });
  it('urgent (wall-clock) pauses and resumes in wall-clock minutes, weekends included', () => {
    const t = ticket('urgent', at('2026-11-14T10:00:00Z'), {
      status: 'open',
      first_responded_at: at('2026-11-14T10:10:00Z'),
    }); // Saturday
    const paused = apply(t, 'pending', at('2026-11-14T11:00:00Z'));
    expect(paused.resolution_remaining_min).toBe(180); // due 14:00Z
    const open = apply(paused, 'open', at('2026-11-20T08:00:00Z'));
    expect(iso(open.resolution_due)).toBe('2026-11-20T11:00:00.000Z');
  });
  it('an unanswered ticket keeps its first-response clock paused too', () => {
    const t = ticket('normal', at('2026-11-12T08:00:00Z'), { status: 'new' }); // Thu 10:00 Kyiv, due Fri 10:00... (540 business min)
    const paused = apply(t, 'pending', at('2026-11-12T09:00:00Z'));
    expect(paused.first_response_remaining_min).toBe(480);
    const open = apply(paused, 'open', at('2026-11-18T07:00:00Z'));
    expect(businessMinutesBetween(at('2026-11-18T07:00:00Z'), open.first_response_due)).toBe(480);
    expect(open.resolution_due.getTime()).toBeGreaterThanOrEqual(open.first_response_due.getTime());
  });
  it('pending → resolved just stops: no restart, resolved_at set, pause cleared', () => {
    const t = ticket('normal', at('2026-11-12T08:00:00Z'), {
      status: 'open',
      first_responded_at: at('2026-11-12T08:30:00Z'),
    });
    const done = apply(
      apply(t, 'pending', at('2026-11-12T09:00:00Z')),
      'resolved',
      at('2026-11-13T09:00:00Z'),
    );
    expect(iso(done.resolved_at)).toBe('2026-11-13T09:00:00.000Z');
    expect(done.sla_paused_at).toBeNull();
    expect(done.resolution_remaining_min).toBeNull();
  });
});

describe('resolved / closed / reopen', () => {
  it('resolved stamps resolved_at; closed stamps closed_at', () => {
    const t = ticket('normal', at('2026-11-12T08:00:00Z'), { status: 'open' });
    expect(iso(apply(t, 'resolved', at('2026-11-12T12:00:00Z')).resolved_at)).toBe(
      '2026-11-12T12:00:00.000Z',
    );
    expect(
      iso(apply({ ...t, status: 'resolved' }, 'closed', at('2026-11-15T12:00:00Z')).closed_at),
    ).toBe('2026-11-15T12:00:00.000Z');
  });
  it('reopening a resolved ticket gets a fresh resolution window and forgets the old resolution breach', () => {
    const created = at('2026-11-02T08:00:00Z');
    const t = ticket('normal', created, {
      status: 'resolved',
      first_responded_at: at('2026-11-02T08:30:00Z'),
      resolved_at: at('2026-11-10T10:00:00Z'),
      resolution_breached_at: at('2026-11-05T15:00:00Z'),
      resolution_warned_at: at('2026-11-05T14:30:00Z'),
    });
    const now = at('2026-11-12T08:00:00Z');
    const re = apply(t, 'open', now);
    expect(re.resolved_at).toBeNull();
    expect(re.resolution_breached_at).toBeNull();
    expect(re.resolution_warned_at).toBeNull();
    expect(re.resolution_due.getTime()).toBeGreaterThan(now.getTime());
    expect(businessMinutesBetween(now, re.resolution_due)).toBe(
      DEFAULT_SLA_POLICIES.normal.resolutionMinutes,
    );
  });
  it('status changes that do not touch the SLA plan nothing', () => {
    const t = ticket('normal', at('2026-11-12T08:00:00Z'), { status: 'new' });
    expect(planStatusChange(t, 'open', at('2026-11-12T09:00:00Z'), DEFAULT_SLA_POLICIES)).toEqual(
      {},
    );
  });
});

describe('priority change recomputes from the moment of CREATION', () => {
  it('normal → urgent: deadlines become created+1h / created+4h (wall clock), not now+…', () => {
    const created = at('2026-11-12T08:00:00Z');
    const t = ticket('normal', created, { status: 'open' });
    const u = planPriorityChange(t, DEFAULT_SLA_POLICIES.urgent, at('2026-11-12T08:20:00Z'));
    expect(iso(u.first_response_due)).toBe('2026-11-12T09:00:00.000Z');
    expect(iso(u.resolution_due)).toBe('2026-11-12T12:00:00.000Z');
  });
  it('urgent → low pushes deadlines out and clears marks that are no longer true', () => {
    const created = at('2026-11-12T08:00:00Z');
    const t = ticket('urgent', created, {
      status: 'open',
      first_response_breached_at: at('2026-11-12T09:00:00Z'),
      first_response_warned_at: at('2026-11-12T08:30:00Z'),
    });
    const u = planPriorityChange(t, DEFAULT_SLA_POLICIES.low, at('2026-11-12T10:00:00Z'));
    expect(u.first_response_breached_at).toBeNull();
    expect(u.first_response_warned_at).toBeNull();
    expect(u.first_response_due!.getTime()).toBeGreaterThan(at('2026-11-13T00:00:00Z').getTime());
  });
  it('normal → urgent on an old ticket marks it breached at once, with the deadline as the breach time', () => {
    const created = at('2026-11-12T06:00:00Z');
    const t = ticket('normal', created, { status: 'open' });
    const now = at('2026-11-12T10:00:00Z'); // 4 h later: first-response (1 h) and resolution (4 h) are over
    const u = planPriorityChange(t, DEFAULT_SLA_POLICIES.urgent, now);
    expect(iso(u.first_response_breached_at)).toBe('2026-11-12T07:00:00.000Z');
    expect(u.resolution_breached_at).toBeNull(); // due exactly now, not yet exceeded
    expect(
      iso(
        planPriorityChange(t, DEFAULT_SLA_POLICIES.urgent, at('2026-11-12T10:01:00Z'))
          .resolution_breached_at,
      ),
    ).toBe('2026-11-12T10:00:00.000Z');
  });
  it('an answered-in-time ticket is not breached after a priority change; answered late stays breached', () => {
    const created = at('2026-11-12T06:00:00Z');
    const ontime = ticket('normal', created, {
      status: 'open',
      first_responded_at: at('2026-11-12T06:30:00Z'),
    });
    expect(
      planPriorityChange(ontime, DEFAULT_SLA_POLICIES.urgent, at('2026-11-12T12:00:00Z'))
        .first_response_breached_at,
    ).toBeNull();
    const late = ticket('normal', created, {
      status: 'open',
      first_responded_at: at('2026-11-12T08:00:00Z'),
    });
    expect(
      iso(
        planPriorityChange(late, DEFAULT_SLA_POLICIES.urgent, at('2026-11-12T12:00:00Z'))
          .first_response_breached_at,
      ),
    ).toBe('2026-11-12T07:00:00.000Z');
  });
  it('while paused, remaining minutes are recomputed against the pause instant', () => {
    const created = at('2026-11-12T08:00:00Z');
    const paused = ticket('normal', created, {
      status: 'pending',
      sla_paused_at: at('2026-11-12T09:00:00Z'),
      first_responded_at: at('2026-11-12T08:30:00Z'),
      resolution_remaining_min: 100,
    });
    const u = planPriorityChange(paused, DEFAULT_SLA_POLICIES.high, at('2026-11-14T09:00:00Z'));
    expect(u.first_response_remaining_min).toBeNull();
    expect(u.resolution_remaining_min).toBe(
      Math.ceil(businessMinutesBetween(at('2026-11-12T09:00:00Z'), u.resolution_due!)),
    );
  });
  it('deadlines never invert (resolution >= first response) for any priority pair', () => {
    for (const from of ['low', 'normal', 'high', 'urgent'] as const)
      for (const to of ['low', 'normal', 'high', 'urgent'] as const) {
        const t = ticket(from, at('2026-11-13T15:00:00Z'));
        const u = planPriorityChange(t, DEFAULT_SLA_POLICIES[to], at('2026-11-14T10:00:00Z'));
        expect(u.resolution_due!.getTime()).toBeGreaterThanOrEqual(u.first_response_due!.getTime());
      }
  });
});
