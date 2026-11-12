import {
  CATEGORIES,
  DEFAULT_SLA_POLICIES,
  addSlaMinutes,
  computeDeadlines,
  remainingSlaMinutes,
  type Category,
  type Priority,
  type TicketStatus,
} from '@helpdesk/shared';
import type {
  agentCategories,
  cannedResponses,
  messages,
  notifications,
  ratings,
  ticketEvents,
  ticketReads,
  tickets,
  users,
} from '../schema';
import { FIRST_TICKET_NUMBER } from '../reference';
import {
  AGENTS,
  CANNED,
  CUSTOMER_BODIES,
  AGENT_BODIES,
  FIRST_NAMES,
  INTERNAL_NOTES,
  LAST_NAMES,
  RATING_COMMENTS,
  SUBJECTS,
  TAGS,
} from './content';
import { createRng, type Rng } from './random';

export const SEED_PASSWORDS = {
  lead: 'Lead#2026pass',
  agent: 'Agent#2026pass',
  customer: 'Customer#2026pass',
} as const;

export const seedEmail = {
  lead: () => 'lead@helpdesk.test',
  agent: (n: number) => `agent${n}@helpdesk.test`,
  customer: (n: number) => `customer${String(n).padStart(3, '0')}@helpdesk.test`,
};

export type SeedOptions = {
  now?: Date;
  tickets?: number;
  customers?: number;
  rngSeed?: number;
  /** Replaces the password hasher (tests use a fast fake). Default: argon2id. */
  hashPassword?: (plain: string) => Promise<string>;
};

type Row<T extends { $inferInsert: unknown }> = T['$inferInsert'];
export type Dataset = {
  users: Row<typeof users>[];
  agentCategories: Row<typeof agentCategories>[];
  canned: Row<typeof cannedResponses>[];
  tickets: Row<typeof tickets>[];
  messages: Row<typeof messages>[];
  events: Row<typeof ticketEvents>[];
  ratings: Row<typeof ratings>[];
  notifications: Row<typeof notifications>[];
  reads: Row<typeof ticketReads>[];
  lastTicketNumber: number;
};

const DAY = 86_400_000;
const MIN = 60_000;

const pickStatus = (rng: Rng, ageDays: number): TicketStatus => {
  if (ageDays < 3)
    return rng.weighted<TicketStatus>([
      ['new', 25],
      ['open', 35],
      ['pending', 15],
      ['resolved', 25],
    ]);
  if (ageDays < 14)
    return rng.weighted<TicketStatus>([
      ['new', 2],
      ['open', 10],
      ['pending', 8],
      ['closed', 80],
    ]);
  return rng.weighted<TicketStatus>([
    ['new', 0.3],
    ['open', 1.5],
    ['pending', 2.5],
    ['closed', 95.7],
  ]);
};

export const generateDataset = (
  options: SeedOptions,
  hashes: { lead: string; agent: string; customer: string },
): Dataset => {
  const now = options.now ?? new Date();
  const ticketCount = options.tickets ?? 20_000;
  const customerCount = options.customers ?? 200;
  const rng = createRng(options.rngSeed ?? 20_260_601);

  const out: Dataset = {
    users: [],
    agentCategories: [],
    canned: [],
    tickets: [],
    messages: [],
    events: [],
    ratings: [],
    notifications: [],
    reads: [],
    lastTicketNumber: FIRST_TICKET_NUMBER,
  };

  /* ---- people ---- */
  const person = () => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
  const leadId = rng.uuid();
  out.users.push({
    id: leadId,
    email: seedEmail.lead(),
    name: 'Володимир Лідер',
    role: 'lead',
    passwordHash: hashes.lead,
    locale: 'uk',
  });

  const agents = AGENTS.map((a, i) => {
    const id = rng.uuid();
    out.users.push({
      id,
      email: seedEmail.agent(i + 1),
      name: a.name,
      role: 'agent',
      passwordHash: hashes.agent,
      locale: i % 3 === 2 ? 'en' : 'uk',
    });
    for (const category of a.categories) out.agentCategories.push({ userId: id, category });
    return { id, categories: a.categories };
  });
  const customers = Array.from({ length: customerCount }, (_, i) => {
    const id = rng.uuid();
    out.users.push({
      id,
      email: seedEmail.customer(i + 1),
      name: person(),
      role: 'customer',
      passwordHash: hashes.customer,
      locale: rng.chance(0.25) ? 'en' : 'uk',
    });
    return { id, name: out.users[out.users.length - 1]?.name ?? '' };
  });
  for (const c of CANNED) out.canned.push({ ...c, createdBy: leadId });

  /* ---- tickets: create timestamps first so numbers follow creation order ---- */
  const createdTimes = Array.from(
    { length: ticketCount },
    () => now.getTime() - rng.int(10, 180 * 1440) * MIN,
  ).sort((a, b) => a - b);
  const closedByCustomer = new Map<string, string[]>();

  createdTimes.forEach((createdMs, index) => {
    const created = new Date(createdMs);
    const number = FIRST_TICKET_NUMBER + index + 1;
    out.lastTicketNumber = number;
    const id = rng.uuid();
    const customer = customers[Math.floor(rng.next() ** 1.6 * customers.length)] ?? customers[0];
    if (!customer) throw new Error('no customers');
    const category: Category = rng.weighted(
      CATEGORIES.map((c) => [c, c === 'other' ? 10 : 22] as const),
    );
    const initialPriority: Priority = rng.weighted<Priority>([
      ['low', 25],
      ['normal', 50],
      ['high', 25],
    ]);
    const escalated = rng.chance(0.05);
    const priority: Priority = escalated ? 'urgent' : initialPriority;
    const policy = DEFAULT_SLA_POLICIES[priority];
    const ageDays = (now.getTime() - createdMs) / DAY;
    let status = pickStatus(rng, ageDays);

    // Assignee: mostly an agent of the category; ~3 % cross-category (agent sees it because it is assigned).
    const eligible = agents.filter((a) => a.categories.includes(category));
    const cross = agents.filter((a) => !a.categories.includes(category));
    const wantsAssignee =
      status === 'new' ? rng.chance(0.04) : !(status === 'open' && rng.chance(0.08));
    const assignee = wantsAssignee
      ? rng.chance(0.03) && cross.length
        ? rng.pick(cross)
        : rng.pick(eligible)
      : null;
    const handled = status !== 'new';

    /* timeline */
    const deadlines = computeDeadlines(created, policy);
    const times = {
      firstResp: null as Date | null,
      resolved: null as Date | null,
      closed: null as Date | null,
    };
    const msgs: Array<{ at: Date; author: 'customer' | 'agent'; kind: 'public' | 'internal' }> = [
      { at: created, author: 'customer', kind: 'public' },
    ];

    if (handled) {
      const first = policy.firstResponseMinutes;
      const delay = rng.weighted([
        [rng.int(3, Math.max(4, Math.floor(first * 0.8))), 70],
        [rng.int(Math.floor(first * 0.8), first), 16],
        [rng.int(Math.floor(first * 1.2), first * 5), 14],
      ]);
      let firstResp = addSlaMinutes(created, delay, policy.businessHours);
      if (firstResp.getTime() > now.getTime() - 5 * MIN) {
        firstResp = new Date(createdMs + (now.getTime() - createdMs) * 0.5);
      }
      times.firstResp = firstResp;
      msgs.push({ at: firstResp, author: 'agent', kind: 'public' });

      // Resolution time follows the policy: ~75 % inside the SLA, ~25 % overrun.
      const resMin = policy.resolutionMinutes;
      const resolveAt = (limitMs: number): Date => {
        const wanted = addSlaMinutes(
          created,
          rng.weighted([
            [rng.int(Math.floor(resMin * 0.2), Math.floor(resMin * 0.9)), 75],
            [rng.int(resMin, resMin * 3), 25],
          ]),
          policy.businessHours,
        );
        const lo = firstResp.getTime() + 5 * MIN;
        if (limitMs <= lo) return new Date(lo);
        return wanted.getTime() >= lo && wanted.getTime() <= limitMs
          ? wanted
          : new Date(lo + (limitMs - lo) * (0.3 + rng.next() * 0.65));
      };
      if (status === 'closed') {
        const limit = now.getTime() - 3 * DAY - 60 * MIN;
        if (limit <= firstResp.getTime() + 5 * MIN) status = 'open';
        else {
          times.resolved = resolveAt(limit);
          times.closed = new Date(times.resolved.getTime() + 3 * DAY);
        }
      } else if (status === 'resolved') {
        times.resolved = resolveAt(now.getTime() - 2 * MIN);
      }
      const lastActivity = times.resolved ? times.resolved.getTime() - MIN : now.getTime() - MIN;
      const span = Math.max(0, lastActivity - firstResp.getTime());
      const rounds = span > 10 * MIN ? rng.int(0, 3) : 0;
      const extra = Array.from(
        { length: rounds * 2 },
        () => firstResp.getTime() + 1 + rng.next() * span,
      ).sort((a, b) => a - b);
      extra.forEach((t, i) =>
        msgs.push({ at: new Date(t), author: i % 2 === 0 ? 'customer' : 'agent', kind: 'public' }),
      );
      if (status === 'open' && span > 10 * MIN && rng.chance(0.5)) {
        msgs.push({
          at: new Date(firstResp.getTime() + span * (0.9 + rng.next() * 0.09)),
          author: 'customer',
          kind: 'public',
        });
      }
      if (assignee && rng.chance(0.3)) {
        for (let n = rng.int(1, 2); n > 0; n -= 1) {
          msgs.push({
            at: new Date(firstResp.getTime() + rng.next() * Math.max(span, MIN)),
            author: 'agent',
            kind: 'internal',
          });
        }
      }
    }
    msgs.sort((a, b) => a.at.getTime() - b.at.getTime());

    const publicMsgs = msgs.filter((m) => m.kind === 'public');
    const lastPublic = publicMsgs[publicMsgs.length - 1];
    const lastAgentPublic = [...publicMsgs].reverse().find((m) => m.author === 'agent');
    const effAssignee = assignee ?? (handled ? rng.pick(eligible) : null);
    for (const m of msgs) {
      const authorId = m.author === 'customer' ? customer.id : (effAssignee?.id ?? leadId);
      const body =
        m.kind === 'internal'
          ? rng.pick(INTERNAL_NOTES)
          : m.author === 'customer'
            ? m.at === created
              ? `${rng.pick(SUBJECTS[category])}. ${rng.pick(CUSTOMER_BODIES)}`
              : rng.pick(CUSTOMER_BODIES)
            : rng.pick(AGENT_BODIES);
      out.messages.push({
        id: rng.uuid(),
        ticketId: id,
        authorId,
        clientId: rng.uuid(),
        kind: m.kind,
        body,
        createdAt: m.at,
      });
    }

    /* SLA flags (what the background job would have recorded) */
    const nowMs = now.getTime();
    const paused = status === 'pending' && lastAgentPublic ? lastAgentPublic.at : null;
    const clockStop = paused?.getTime() ?? nowMs;
    const breachedAt = (due: Date, doneAt: Date | null): Date | null => {
      const reference = doneAt ?? new Date(clockStop);
      return reference.getTime() > due.getTime() && due.getTime() <= nowMs ? due : null;
    };
    const warnedAt = (due: Date, doneAt: Date | null): Date | null => {
      const at = new Date(due.getTime() - 30 * MIN);
      const reference = doneAt ?? new Date(clockStop);
      return reference.getTime() >= at.getTime() && at.getTime() <= nowMs ? at : null;
    };
    const resolutionDoneAt = times.resolved;
    const stillRunning = status === 'new' || status === 'open' || status === 'pending';
    const firstBreach = breachedAt(deadlines.firstResponseDue, times.firstResp);
    const resBreach = breachedAt(deadlines.resolutionDue, resolutionDoneAt);

    const tags = rng.chance(0.25)
      ? [...new Set(Array.from({ length: rng.int(1, 3) }, () => rng.pick(TAGS)))]
      : [];

    // continuation of an earlier closed ticket of the same customer
    const earlierClosed = closedByCustomer.get(customer.id);
    const linkedTicketId =
      earlierClosed?.length && rng.chance(0.04) ? rng.pick(earlierClosed) : null;
    if (status === 'closed') closedByCustomer.set(customer.id, [...(earlierClosed ?? []), id]);

    /* history */
    const ev = (
      at: Date,
      field: Row<typeof ticketEvents>['field'],
      oldValue: string | null,
      newValue: string | null,
      actorId: string | null,
    ) => out.events.push({ ticketId: id, actorId, field, oldValue, newValue, createdAt: at });
    const eventsStart = out.events.length;
    ev(created, 'created', null, `HD-${number}`, customer.id);
    let updated = msgs[msgs.length - 1]?.at ?? created;
    if (handled && times.firstResp && effAssignee) {
      const t0 = new Date(times.firstResp.getTime() - MIN);
      if (assignee) ev(t0, 'assignee', null, assignee.id, rng.chance(0.5) ? leadId : assignee.id);
      if (escalated) ev(t0, 'priority', initialPriority, 'urgent', effAssignee.id);
      ev(times.firstResp, 'status', 'new', 'open', effAssignee.id);
      if (status === 'pending' && lastAgentPublic)
        ev(lastAgentPublic.at, 'status', 'open', 'pending', effAssignee.id);
      if (times.resolved) ev(times.resolved, 'status', 'open', 'resolved', effAssignee.id);
      if (times.closed) ev(times.closed, 'status', 'resolved', 'closed', null);
    } else if (escalated) {
      ev(new Date(createdMs + 2 * MIN), 'priority', initialPriority, 'urgent', leadId);
    }
    for (const t of [times.resolved, times.closed]) if (t && t > updated) updated = t;
    if (updated.getTime() > nowMs) updated = now;

    out.tickets.push({
      id,
      number,
      subject: rng.pick(SUBJECTS[category]),
      category,
      priority,
      status,
      customerId: customer.id,
      assigneeId: assignee?.id ?? null,
      tags,
      version: out.events.length - eventsStart,
      linkedTicketId,
      createdAt: created,
      updatedAt: updated,
      lastPublicMessageAt: lastPublic?.at ?? created,
      firstResponseDue: deadlines.firstResponseDue,
      resolutionDue: deadlines.resolutionDue,
      firstRespondedAt: times.firstResp,
      resolvedAt: times.resolved,
      closedAt: times.closed,
      slaPausedAt: paused,
      firstResponseRemainingMin: paused
        ? remainingSlaMinutes(paused, deadlines.firstResponseDue, policy.businessHours)
        : null,
      resolutionRemainingMin: paused
        ? remainingSlaMinutes(paused, deadlines.resolutionDue, policy.businessHours)
        : null,
      firstResponseWarnedAt:
        stillRunning || times.firstResp
          ? warnedAt(deadlines.firstResponseDue, times.firstResp)
          : null,
      resolutionWarnedAt: stillRunning ? warnedAt(deadlines.resolutionDue, resolutionDoneAt) : null,
      firstResponseBreachedAt: firstBreach,
      resolutionBreachedAt: resBreach,
    });

    /* ratings, reads, notifications */
    if (times.resolved && (status === 'resolved' || status === 'closed') && rng.chance(0.45)) {
      out.ratings.push({
        ticketId: id,
        customerId: customer.id,
        score: rng.weighted([
          [5, 40],
          [4, 30],
          [3, 15],
          [2, 8],
          [1, 7],
        ]),
        comment: rng.chance(0.3) ? rng.pick(RATING_COMMENTS) : null,
        createdAt: new Date(
          times.resolved.getTime() + rng.int(1, 600) * MIN > nowMs
            ? nowMs
            : times.resolved.getTime() + rng.int(1, 600) * MIN,
        ),
      });
    }
    if (lastAgentPublic && rng.chance(0.75))
      out.reads.push({ userId: customer.id, ticketId: id, lastReadAt: updated });
    if (assignee && ageDays < 3) {
      out.notifications.push({
        userId: assignee.id,
        type: 'assigned',
        ticketId: id,
        dedupeKey: 'assigned',
        createdAt: created,
        readAt: rng.chance(0.4) ? updated : null,
      });
      if (lastPublic?.author === 'customer' && status === 'open') {
        out.notifications.push({
          userId: assignee.id,
          type: 'customer_replied',
          ticketId: id,
          dedupeKey: `reply:${lastPublic.at.getTime()}`,
          createdAt: lastPublic.at,
          readAt: null,
        });
      }
    }
  });

  return out;
};
