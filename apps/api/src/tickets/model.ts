import type { Category, Priority, Role, SlaInfo, TicketDto, TicketStatus } from '@helpdesk/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessionUser } from '../lib/sessions';
import type { Queryable } from './db';

/** A ticket as selected by TICKET_SELECT (snake_case straight from PostgreSQL). */
export type TicketRow = {
  id: string;
  number: number;
  subject: string;
  category: Category;
  priority: Priority;
  status: TicketStatus;
  customer_id: string;
  assignee_id: string | null;
  tags: string[];
  version: number;
  linked_ticket_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_public_message_at: Date | null;
  first_response_due: Date;
  resolution_due: Date;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  sla_paused_at: Date | null;
  first_response_remaining_min: number | null;
  resolution_remaining_min: number | null;
  first_response_warned_at: Date | null;
  resolution_warned_at: Date | null;
  first_response_breached_at: Date | null;
  resolution_breached_at: Date | null;
  sla_due_at: Date | null;
  customer_name: string;
  assignee_name: string | null;
  unread: boolean;
};

export const isStaff = (role: Role): boolean => role === 'agent' || role === 'lead';

/** Columns + joins shared by every ticket read. `unread` is only ever true for a customer viewer. */
export const ticketSelect = (viewer: SessionUser): SQL => sql`
  SELECT t.id, t.number, t.subject, t.category, t.priority, t.status, t.customer_id, t.assignee_id, t.tags,
         t.version, t.linked_ticket_id, t.created_at, t.updated_at, t.last_public_message_at,
         t.first_response_due, t.resolution_due, t.first_responded_at, t.resolved_at, t.closed_at,
         t.sla_paused_at, t.first_response_remaining_min, t.resolution_remaining_min,
         t.first_response_warned_at, t.resolution_warned_at, t.first_response_breached_at,
         t.resolution_breached_at, t.sla_due_at,
         cu.name AS customer_name, au.name AS assignee_name,
         ${
           viewer.role === 'customer'
             ? sql`EXISTS (
                 SELECT 1 FROM messages m JOIN users a ON a.id = m.author_id
                 WHERE m.ticket_id = t.id AND m.kind = 'public' AND a.role <> 'customer'
                   AND m.created_at > COALESCE((SELECT r.last_read_at FROM ticket_reads r WHERE r.ticket_id = t.id AND r.user_id = ${viewer.id}), '-infinity'::timestamptz)
               )`
             : sql`false`
         } AS unread
  FROM tickets t
  JOIN users cu ON cu.id = t.customer_id
  LEFT JOIN users au ON au.id = t.assignee_id`;

/**
 * Which tickets a user may see — applied in the SQL itself, never after loading:
 * customer = own; agent = own categories OR assigned to them; lead = everything.
 */
export const visibleTo = (user: SessionUser): SQL => {
  if (user.role === 'lead') return sql`true`;
  if (user.role === 'customer') return sql`t.customer_id = ${user.id}`;
  if (user.categories.length === 0) return sql`t.assignee_id = ${user.id}`;
  const cats = sql.join(
    user.categories.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`(t.assignee_id = ${user.id} OR t.category IN (${cats}))`;
};

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const slaInfo = (t: TicketRow): SlaInfo => ({
  firstResponseDue: iso(t.first_response_due),
  resolutionDue: iso(t.resolution_due),
  firstRespondedAt: isoOrNull(t.first_responded_at),
  resolvedAt: isoOrNull(t.resolved_at),
  dueAt: isoOrNull(t.sla_due_at),
  pausedAt: isoOrNull(t.sla_paused_at),
  firstResponseBreached: t.first_response_breached_at !== null,
  resolutionBreached: t.resolution_breached_at !== null,
  breached: t.first_response_breached_at !== null || t.resolution_breached_at !== null,
});

/** Customers never get tags or SLA data (internal). */
export const toTicketDto = (t: TicketRow, viewerRole: Role): TicketDto => ({
  id: t.id,
  number: t.number,
  code: `HD-${t.number}`,
  subject: t.subject,
  category: t.category,
  priority: t.priority,
  status: t.status,
  customer: { id: t.customer_id, name: t.customer_name },
  assignee: t.assignee_id ? { id: t.assignee_id, name: t.assignee_name ?? '' } : null,
  tags: isStaff(viewerRole) ? t.tags : [],
  version: t.version,
  linkedTicketId: t.linked_ticket_id,
  createdAt: iso(t.created_at),
  updatedAt: iso(t.updated_at),
  lastPublicMessageAt: isoOrNull(t.last_public_message_at),
  unread: viewerRole === 'customer' ? t.unread : false,
  sla: isStaff(viewerRole) ? slaInfo(t) : null,
});

/** node-postgres hands raw `execute()` timestamps back as strings; every consumer wants Dates. */
export const toDate = <T extends Date | string | null>(v: T): T extends null ? null : Date =>
  (v === null ? null : v instanceof Date ? v : new Date(v)) as T extends null ? null : Date;

const DATE_COLUMNS = [
  'created_at',
  'updated_at',
  'last_public_message_at',
  'first_response_due',
  'resolution_due',
  'first_responded_at',
  'resolved_at',
  'closed_at',
  'sla_paused_at',
  'first_response_warned_at',
  'resolution_warned_at',
  'first_response_breached_at',
  'resolution_breached_at',
  'sla_due_at',
] as const;

/** Runs a query built from ticketSelect(...) and returns rows with real Date objects. */
export const readTickets = async (db: Queryable, query: SQL): Promise<TicketRow[]> => {
  const res = await db.execute<Record<string, unknown>>(query);
  return res.rows.map((raw) => {
    const row: Record<string, unknown> = { ...raw };
    for (const c of DATE_COLUMNS) row[c] = toDate(raw[c] as Date | string | null);
    return row as unknown as TicketRow;
  });
};
