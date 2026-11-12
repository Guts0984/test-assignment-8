import { allocateTicketNumber } from '@helpdesk/db';
import {
  computeDeadlines,
  type Category,
  type Priority,
  type SlaPolicy,
  type TicketStatus,
} from '@helpdesk/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessionUser } from '../lib/sessions';
import type { Queryable, Tx } from './db';
import { emit, notify, recordEvent } from './history';
import { readTickets, ticketSelect, visibleTo, type TicketRow } from './model';
import { planPriorityChange, planStatusChange, type Policies, type SlaUpdate } from './sla-plan';

export const loadPolicies = async (db: Queryable): Promise<Policies> => {
  const res = await db.execute<{
    priority: Priority;
    first_response_minutes: number;
    resolution_minutes: number;
    business_hours: boolean;
  }>(
    sql`SELECT priority, first_response_minutes, resolution_minutes, business_hours FROM sla_policies`,
  );
  const map = {} as Record<Priority, SlaPolicy>;
  for (const r of res.rows) {
    map[r.priority] = {
      firstResponseMinutes: r.first_response_minutes,
      resolutionMinutes: r.resolution_minutes,
      businessHours: r.business_hours,
    };
  }
  return map;
};

/** Reads one ticket the viewer may see (NULL otherwise — callers answer 404, never 403, to avoid leaking existence). */
export const fetchTicket = async (
  db: Queryable,
  viewer: SessionUser,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<TicketRow | undefined> => {
  const rows = await readTickets(
    db,
    sql`${ticketSelect(viewer)} WHERE t.id = ${id} AND ${visibleTo(viewer)} ${opts.lock ? sql`FOR UPDATE OF t` : sql``}`,
  );
  return rows[0];
};

export type Changes = {
  status?: TicketStatus;
  priority?: Priority;
  category?: Category;
  assigneeId?: string | null;
  tags?: string[];
};
export type FieldName = 'status' | 'priority' | 'category' | 'assignee' | 'tags';

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

/** The fields a patch would actually change. Pure. */
export const diffChanges = (row: TicketRow, c: Changes): FieldName[] => {
  const out: FieldName[] = [];
  if (c.status !== undefined && c.status !== row.status) out.push('status');
  if (c.priority !== undefined && c.priority !== row.priority) out.push('priority');
  if (c.category !== undefined && c.category !== row.category) out.push('category');
  if (c.assigneeId !== undefined && c.assigneeId !== row.assignee_id) out.push('assignee');
  if (c.tags !== undefined && !sameSet(c.tags, row.tags)) out.push('tags');
  return out;
};

const setClause = (col: string, value: unknown): SQL => sql`${sql.raw(`"${col}"`)} = ${value}`;

export type Extras = Partial<{ first_responded_at: Date; last_public_message_at: Date }>;

/**
 * THE way a ticket changes. Caller must hold the row lock (FOR UPDATE) and have checked permissions.
 * One UPDATE: fields + SLA consequences + version bump; plus history rows, an SSE event and notifications.
 * Returns the fresh row. If nothing changes, nothing is written (no version bump, no history).
 */
export const applyChanges = async (
  tx: Tx,
  o: {
    actor: SessionUser | null;
    row: TicketRow;
    changes: Changes;
    policies: Policies;
    now: Date;
    extras?: Extras;
  },
): Promise<{ row: TicketRow; changed: FieldName[] }> => {
  const { row, changes, now } = o;
  const changed = diffChanges(row, changes);
  const extras = o.extras ?? {};
  const hasExtras = Object.keys(extras).length > 0;
  if (changed.length === 0 && !hasExtras) return { row, changed };

  const sets: SQL[] = [setClause('updated_at', now)];
  for (const [k, v] of Object.entries(extras)) sets.push(setClause(k, v));

  if (changed.length > 0) {
    sets.push(sql`version = version + 1`);
    const sla: SlaUpdate = {};
    let virtual: TicketRow = row;
    if (changed.includes('status') && changes.status) {
      const u = planStatusChange(row, changes.status, now, o.policies);
      Object.assign(sla, u);
      virtual = { ...row, ...u, status: changes.status } as TicketRow;
      sets.push(setClause('status', changes.status));
    }
    if (changed.includes('priority') && changes.priority) {
      Object.assign(sla, planPriorityChange(virtual, o.policies[changes.priority], now));
      sets.push(setClause('priority', changes.priority));
    }
    if (changed.includes('category') && changes.category)
      sets.push(setClause('category', changes.category));
    if (changed.includes('assignee'))
      sets.push(setClause('assignee_id', changes.assigneeId ?? null));
    if (changed.includes('tags') && changes.tags)
      sets.push(
        sql`tags = ${sql.raw('ARRAY[')}${
          changes.tags.length
            ? sql.join(
                changes.tags.map((t) => sql`${t}`),
                sql`, `,
              )
            : sql``
        }${sql.raw(']::text[]')}`,
      );
    for (const [k, v] of Object.entries(sla)) sets.push(setClause(k, v));
  }

  await tx.execute(
    sql`UPDATE tickets SET ${sql.join(sets, sql`, `)} WHERE id = ${row.id} AND version = ${row.version}`,
  );
  const fresh = (
    await readTickets(
      tx,
      sql`${ticketSelect({ id: '00000000-0000-0000-0000-000000000000', role: 'lead' } as SessionUser)} WHERE t.id = ${row.id}`,
    )
  )[0];
  if (!fresh) throw new Error('ticket vanished during update');

  const actorId = o.actor?.id ?? null;
  const before: Record<FieldName, string | null> = {
    status: row.status,
    priority: row.priority,
    category: row.category,
    assignee: row.assignee_id,
    tags: row.tags.join(','),
  };
  const after: Record<FieldName, string | null> = {
    status: fresh.status,
    priority: fresh.priority,
    category: fresh.category,
    assignee: fresh.assignee_id,
    tags: fresh.tags.join(','),
  };
  for (const field of changed)
    await recordEvent(tx, {
      ticketId: row.id,
      actorId,
      field,
      oldValue: before[field],
      newValue: after[field],
      at: now,
    });

  if (changed.includes('assignee') && fresh.assignee_id && fresh.assignee_id !== actorId) {
    await notify(tx, {
      userId: fresh.assignee_id,
      type: 'assigned',
      ticketId: row.id,
      dedupeKey: `assigned:${fresh.version}`,
    });
  }
  if (changed.length > 0)
    await emit(tx, 'ticket.changed', row.id, { version: fresh.version, changed });
  return { row: fresh, changed };
};

/* ------------------------------------------------------------------ attachments */

/** Attaches the caller's own, still-unattached uploads to a message. All-or-nothing. */
export const linkAttachments = async (
  tx: Tx,
  userId: string,
  messageId: string,
  ids: readonly string[],
): Promise<boolean> => {
  if (ids.length === 0) return true;
  const list = sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  );
  const res = await tx.execute(
    sql`UPDATE attachments SET message_id = ${messageId} WHERE id IN (${list}) AND uploader_id = ${userId} AND message_id IS NULL`,
  );
  return (res.rowCount ?? 0) === ids.length;
};

/* ------------------------------------------------------------------ creation */

export type NewTicket = {
  subject: string;
  category: Category;
  priority: Priority;
  body: string;
  attachmentIds: readonly string[];
  clientMessageId: string;
  linkedTicketId?: string | null;
};

/** Inserts ticket + first message (+ history, event). Caller supplies the transaction and checks permissions. */
export const insertTicket = async (
  tx: Tx,
  customer: SessionUser,
  input: NewTicket,
  policies: Policies,
  now: Date,
): Promise<{ ticketId: string; messageId: string; attachmentsOk: boolean }> => {
  const policy = policies[input.priority];
  const dl = computeDeadlines(now, policy);
  const number = await allocateTicketNumber(tx);
  const t = await tx.execute<{ id: string }>(sql`
    INSERT INTO tickets (number, subject, category, priority, status, customer_id, linked_ticket_id,
                         created_at, updated_at, last_public_message_at, first_response_due, resolution_due)
    VALUES (${number}, ${input.subject}, ${input.category}, ${input.priority}, 'new', ${customer.id}, ${input.linkedTicketId ?? null},
            ${now}, ${now}, ${now}, ${dl.firstResponseDue}, ${dl.resolutionDue})
    RETURNING id`);
  const ticketId = t.rows[0]?.id;
  if (!ticketId) throw new Error('ticket insert returned nothing');
  const m = await tx.execute<{ id: string }>(sql`
    INSERT INTO messages (ticket_id, author_id, client_id, kind, body, created_at)
    VALUES (${ticketId}, ${customer.id}, ${input.clientMessageId}, 'public', ${input.body}, ${now})
    RETURNING id`);
  const messageId = m.rows[0]?.id;
  if (!messageId) throw new Error('message insert returned nothing');
  const attachmentsOk = await linkAttachments(tx, customer.id, messageId, input.attachmentIds);
  await recordEvent(tx, {
    ticketId,
    actorId: customer.id,
    field: 'created',
    oldValue: null,
    newValue: `HD-${number}`,
    at: now,
  });
  await emit(tx, 'ticket.created', ticketId, {});
  return { ticketId, messageId, attachmentsOk };
};
