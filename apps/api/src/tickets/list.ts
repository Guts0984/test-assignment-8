import type { DbHandle } from '@helpdesk/db';
import type { ListTicketsQuery, TicketList } from '@helpdesk/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { appError } from '../lib/errors';
import type { SessionUser } from '../lib/sessions';
import {
  isStaff,
  readTickets,
  ticketSelect,
  toTicketDto,
  visibleTo,
  type TicketRow,
} from './model';

const cursorSchema = z.object({
  /** sort + order the cursor was issued for (a cursor from another sort is meaningless) */
  s: z.enum(['sla', 'created', 'updated']),
  o: z.enum(['asc', 'desc']),
  /** value of the sort column of the last row: ISO date, or null (sla only) */
  v: z.string().datetime({ offset: true }).nullable(),
  id: z.string().uuid(),
});
type Cursor = z.infer<typeof cursorSchema>;

export const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

/** Tampered, truncated or foreign cursors are a 400, never a 500 and never "page 1 again". */
export const decodeCursor = (raw: string): Cursor => {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw appError(400, 'validation_error', 'Invalid cursor');
  }
};

const COLUMN = {
  sla: sql.raw('t.sla_due_at'),
  created: sql.raw('t.created_at'),
  updated: sql.raw('t.updated_at'),
} as const;

const filters = (user: SessionUser, q: ListTicketsQuery): SQL[] => {
  const out: SQL[] = [visibleTo(user)];
  const staff = isStaff(user.role);
  if (q.status?.length)
    out.push(
      sql`t.status IN (${sql.join(
        q.status.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (q.priority?.length)
    out.push(
      sql`t.priority IN (${sql.join(
        q.priority.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (q.category?.length)
    out.push(
      sql`t.category IN (${sql.join(
        q.category.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (q.createdFrom) out.push(sql`t.created_at >= ${q.createdFrom}`);
  if (q.createdTo) out.push(sql`t.created_at <= ${q.createdTo}`);
  // staff-only metadata: ignored for customers (no error, no information)
  if (staff) {
    if (q.assignee === 'me') out.push(sql`t.assignee_id = ${user.id}`);
    else if (q.assignee === 'none') out.push(sql`t.assignee_id IS NULL`);
    else if (q.assignee) out.push(sql`t.assignee_id = ${q.assignee}`);
    if (q.slaBreached === true)
      out.push(
        sql`(t.first_response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL)`,
      );
    if (q.slaBreached === false)
      out.push(sql`(t.first_response_breached_at IS NULL AND t.resolution_breached_at IS NULL)`);
    if (q.tags?.length)
      out.push(
        sql`t.tags @> ARRAY[${sql.join(
          q.tags.map((t) => sql`${t}`),
          sql`, `,
        )}]::text[]`,
      );
  }
  if (q.q) {
    // subject OR any message the viewer may read. Customers must NOT match on internal notes.
    const msgFilter = staff ? sql`` : sql`AND m.kind = 'public'`;
    out.push(sql`t.id IN (
      SELECT s.id FROM tickets s WHERE s.search @@ plainto_tsquery('simple', ${q.q})
      UNION
      SELECT m.ticket_id FROM messages m WHERE m.search @@ plainto_tsquery('simple', ${q.q}) ${msgFilter}
    )`);
  }
  return out;
};

/** Keyset condition: rows strictly after the cursor in the requested order. NULLs sort last in both directions. */
const afterCursor = (q: ListTicketsQuery, c: Cursor): SQL => {
  const col = COLUMN[q.sort];
  const asc = q.order === 'asc';
  const cmp = asc ? sql.raw('>') : sql.raw('<');
  if (q.sort !== 'sla') return sql`(${col}, t.id) ${cmp} (${c.v}::timestamptz, ${c.id}::uuid)`;
  if (c.v === null) return sql`(${col} IS NULL AND t.id ${cmp} ${c.id}::uuid)`;
  return sql`((${col}, t.id) ${cmp} (${c.v}::timestamptz, ${c.id}::uuid) OR ${col} IS NULL)`;
};

export const listTickets = async (
  db: DbHandle,
  user: SessionUser,
  q: ListTicketsQuery,
): Promise<TicketList> => {
  const where = filters(user, q);
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c.s !== q.sort || c.o !== q.order)
      throw appError(400, 'validation_error', 'Cursor does not match the requested sort');
    // only the SLA deadline can be NULL; a NULL position for created/updated is a forged cursor (it would silently yield an empty page)
    if (c.v === null && q.sort !== 'sla') throw appError(400, 'validation_error', 'Invalid cursor');
    where.push(afterCursor(q, c));
  }
  const col = COLUMN[q.sort];
  const dir = q.order === 'asc' ? sql.raw('ASC') : sql.raw('DESC');
  const nulls = q.sort === 'sla' ? sql.raw(' NULLS LAST') : sql.raw('');
  const rows = await readTickets(
    db.db,
    sql`
    ${ticketSelect(user)}
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${col} ${dir}${nulls}, t.id ${dir}
    LIMIT ${q.limit + 1}`,
  );
  const page = rows.slice(0, q.limit);
  const more = rows.length > q.limit;
  const last = page[page.length - 1];
  const keyOf = (t: TicketRow): Date | null =>
    q.sort === 'sla' ? t.sla_due_at : q.sort === 'created' ? t.created_at : t.updated_at;
  return {
    items: page.map((t) => toTicketDto(t, user.role)),
    nextCursor:
      more && last
        ? encodeCursor({
            s: q.sort,
            o: q.order,
            v: keyOf(last)?.toISOString() ?? null,
            id: last.id,
          })
        : null,
  };
};
