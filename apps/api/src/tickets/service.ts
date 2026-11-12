import type { DbHandle } from '@helpdesk/db';
import {
  statusAfterMessage,
  canTransition,
  type CreateMessageInput,
  type CreateTicketInput,
  type MessageDto,
  type MessageResult,
  type PatchTicketInput,
  type TicketDetail,
  type TicketDto,
} from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import { appError } from '../lib/errors';
import type { SessionUser } from '../lib/sessions';
import { authorizeChanges, toChanges } from './authorize';
import type { Queryable } from './db';
import { emit, notify } from './history';
import { toTicketDto, ticketSelect, visibleTo, isStaff, toDate, type TicketRow } from './model';
import { applyChanges, fetchTicket, insertTicket, linkAttachments, loadPolicies } from './mutate';

type Deps = { db: DbHandle; now?: () => Date };
const nowOf = (d: Deps) => (d.now ?? (() => new Date()))();

/* ------------------------------------------------------------------ reading */

export const loadMessages = async (
  db: Queryable,
  ticketId: string,
  includeInternal: boolean,
): Promise<MessageDto[]> => {
  const res = await db.execute<{
    id: string;
    ticket_id: string;
    kind: 'public' | 'internal';
    body: string;
    created_at: Date | string;
    author_id: string;
    author_name: string;
    author_role: 'customer' | 'agent' | 'lead';
    attachments: Array<{ id: string; name: string; mime: string; sizeBytes: number }> | null;
  }>(sql`
    SELECT m.id, m.ticket_id, m.kind, m.body, m.created_at, u.id AS author_id, u.name AS author_name, u.role AS author_role,
           (SELECT json_agg(json_build_object('id', a.id, 'name', a.original_name, 'mime', a.mime, 'sizeBytes', a.size_bytes) ORDER BY a.created_at, a.id)
              FROM attachments a WHERE a.message_id = m.id) AS attachments
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.ticket_id = ${ticketId} ${includeInternal ? sql`` : sql`AND m.kind = 'public'`}
    ORDER BY m.created_at, m.id`);
  return res.rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    author: { id: r.author_id, name: r.author_name, role: r.author_role },
    kind: r.kind,
    body: r.body,
    createdAt: toDate(r.created_at).toISOString(),
    attachments: r.attachments ?? [],
  }));
};

export const getTicketDetail = async (
  deps: Deps,
  user: SessionUser,
  id: string,
): Promise<TicketDetail> => {
  const row = await fetchTicket(deps.db.db, user, id);
  if (!row) throw appError(404, 'not_found', 'Ticket not found');
  const staff = isStaff(user.role);
  const messages = await loadMessages(deps.db.db, id, staff); // internal notes are filtered in SQL
  const events = staff
    ? (
        await deps.db.db.execute<{
          id: number;
          field: TicketDetail['events'][number]['field'];
          old_value: string | null;
          new_value: string | null;
          created_at: Date | string;
          actor_id: string | null;
          actor_name: string | null;
        }>(sql`
          SELECT e.id, e.field, e.old_value, e.new_value, e.created_at, e.actor_id, u.name AS actor_name
          FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.ticket_id = ${id} ORDER BY e.created_at, e.id`)
      ).rows.map((e) => ({
        id: Number(e.id),
        actor: e.actor_id ? { id: e.actor_id, name: e.actor_name ?? '' } : null,
        field: e.field,
        oldValue: e.old_value,
        newValue: e.new_value,
        createdAt: toDate(e.created_at).toISOString(),
      }))
    : [];
  const rating =
    (
      await deps.db.db.execute<{ score: number; comment: string | null }>(
        sql`SELECT score, comment FROM ratings WHERE ticket_id = ${id}`,
      )
    ).rows[0] ?? null;
  return { ticket: toTicketDto(row, user.role), messages, events, rating };
};

/* ------------------------------------------------------------------ create */

const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i += 1) {
    const e = cur as { code?: string; constraint?: string; cause?: unknown };
    if (e.code === '23505' && e.constraint === constraint) return true;
    cur = e.cause;
  }
  return false;
};

/** Returns the ticket created from this exact client message id (a repeat request), or null. */
const findReplay = async (
  db: Queryable,
  user: SessionUser,
  clientMessageId: string,
): Promise<string | null> => {
  const r = await db.execute<{ ticket_id: string; first: boolean; mine: boolean }>(sql`
    SELECT m.ticket_id, (m.created_at = t.created_at) AS first, (t.customer_id = ${user.id}) AS mine
    FROM messages m JOIN tickets t ON t.id = m.ticket_id
    WHERE m.author_id = ${user.id} AND m.client_id = ${clientMessageId}`);
  const row = r.rows[0];
  if (!row) return null;
  if (!row.first || !row.mine)
    throw appError(409, 'conflict', 'This message id was already used for something else');
  return row.ticket_id;
};

export const createTicket = async (
  deps: Deps,
  user: SessionUser,
  input: CreateTicketInput,
): Promise<{ ticket: TicketDto; replayed: boolean }> => {
  if (user.role !== 'customer') throw appError(403, 'forbidden', 'Only customers create tickets');
  const replayOf = await findReplay(deps.db.db, user, input.clientMessageId);
  if (replayOf) {
    const row = await fetchTicket(deps.db.db, user, replayOf);
    if (row) return { ticket: toTicketDto(row, user.role), replayed: true };
  }
  try {
    const ticketId = await deps.db.db.transaction(async (tx) => {
      const policies = await loadPolicies(tx);
      const made = await insertTicket(tx, user, input, policies, nowOf(deps));
      if (!made.attachmentsOk)
        throw appError(
          400,
          'validation_error',
          'Some attachments do not exist, are not yours, or are already used',
        );
      return made.ticketId;
    });
    const row = await fetchTicket(deps.db.db, user, ticketId);
    if (!row) throw new Error('created ticket not visible');
    return { ticket: toTicketDto(row, user.role), replayed: false };
  } catch (err) {
    if (isUniqueViolation(err, 'messages_author_client_uq')) {
      const again = await findReplay(deps.db.db, user, input.clientMessageId);
      const row = again ? await fetchTicket(deps.db.db, user, again) : undefined;
      if (row) return { ticket: toTicketDto(row, user.role), replayed: true };
    }
    throw err;
  }
};

/* ------------------------------------------------------------------ patch */

export const patchTicket = async (
  deps: Deps,
  user: SessionUser,
  id: string,
  patch: PatchTicketInput,
): Promise<TicketDto> => {
  const changes = toChanges(patch);
  return deps.db.db.transaction(async (tx) => {
    const row = await fetchTicket(tx, user, id, { lock: true });
    if (!row) throw appError(404, 'not_found', 'Ticket not found');
    if (row.version !== patch.version) {
      throw appError(409, 'version_conflict', 'The ticket was changed by someone else', {
        current: toTicketDto(row, user.role),
      });
    }
    const eligible =
      typeof changes.assigneeId === 'string'
        ? await isEligibleAssignee(tx, changes.assigneeId)
        : true;
    const denied = authorizeChanges(user, row, changes, eligible);
    if (denied) throw appError(denied.status, denied.code, denied.message);
    const policies = await loadPolicies(tx);
    const res = await applyChanges(tx, { actor: user, row, changes, policies, now: nowOf(deps) });
    return toTicketDto(res.row, user.role);
  });
};

export const isEligibleAssignee = async (db: Queryable, userId: string): Promise<boolean> => {
  const r = await db.execute(
    sql`SELECT 1 FROM users WHERE id = ${userId} AND role = 'agent' AND disabled = false`,
  );
  return (r.rowCount ?? 0) > 0;
};

/* ------------------------------------------------------------------ messages */

export const postMessage = async (
  deps: Deps,
  user: SessionUser,
  ticketId: string,
  input: CreateMessageInput,
): Promise<{ result: MessageResult; created: boolean }> => {
  const now = nowOf(deps);
  return deps.db.db.transaction(async (tx) => {
    const row = await fetchTicket(tx, user, ticketId, { lock: true }); // serialises everything on this ticket
    if (!row) throw appError(404, 'not_found', 'Ticket not found');

    // idempotency: the same client id from the same author never creates a second message
    const prior = (
      await tx.execute<{ id: string; ticket_id: string; body: string; kind: string }>(
        sql`SELECT id, ticket_id, body, kind FROM messages WHERE author_id = ${user.id} AND client_id = ${input.id}`,
      )
    ).rows[0];
    if (prior) {
      if (prior.body !== input.body || prior.kind !== input.kind) {
        throw appError(409, 'conflict', 'This message id was already used with different content');
      }
      if (prior.ticket_id !== ticketId) {
        // the first attempt answered a CLOSED ticket: it spawned a linked ticket that carries this message id;
        // a retry returns that same ticket instead of a false conflict
        const spawned = (
          await tx.execute<{ id: string }>(
            sql`SELECT id FROM tickets WHERE id = ${prior.ticket_id} AND linked_ticket_id = ${ticketId}`,
          )
        ).rows[0];
        if (!spawned)
          throw appError(
            409,
            'conflict',
            'This message id was already used with different content',
          );
        const fresh = await fetchTicket(tx, user, spawned.id);
        const first = (await loadMessages(tx, spawned.id, false))[0];
        if (!fresh || !first) throw new Error('replayed spawned ticket not readable');
        return {
          created: false,
          result: {
            message: first,
            ticket: toTicketDto(fresh, user.role),
            replayed: true,
            spawnedFrom: row.id,
          },
        };
      }
      const msg = (await loadMessages(tx, ticketId, isStaff(user.role))).find(
        (m) => m.id === prior.id,
      );
      if (!msg) throw new Error('replayed message not visible');
      return {
        created: false,
        result: {
          message: msg,
          ticket: toTicketDto(row, user.role),
          replayed: true,
          spawnedFrom: null,
        },
      };
    }

    if (user.role === 'customer' && input.setStatus)
      throw appError(400, 'validation_error', 'Customers cannot set a status with a reply');
    const outcome = statusAfterMessage({
      status: row.status,
      authorRole: user.role,
      kind: input.kind,
    });
    if (outcome.type === 'reject') {
      throw outcome.reason === 'internal_note_by_customer'
        ? appError(403, 'forbidden', 'Customers cannot write internal notes')
        : appError(409, 'invalid_transition', 'The ticket is closed');
    }

    // customer answers a closed ticket → a NEW ticket that links back to the old one
    if (outcome.type === 'spawn-linked-ticket') {
      const policies = await loadPolicies(tx);
      const made = await insertTicket(
        tx,
        user,
        {
          subject: row.subject,
          category: row.category,
          priority: row.priority === 'urgent' ? 'high' : row.priority, // customers cannot pick urgent
          body: input.body,
          attachmentIds: input.attachmentIds,
          clientMessageId: input.id,
          linkedTicketId: row.id,
        },
        policies,
        now,
      );
      if (!made.attachmentsOk)
        throw appError(
          400,
          'validation_error',
          'Some attachments do not exist, are not yours, or are already used',
        );
      const fresh = await fetchTicket(tx, user, made.ticketId);
      const msg = (await loadMessages(tx, made.ticketId, false))[0];
      if (!fresh || !msg) throw new Error('spawned ticket not readable');
      return {
        created: true,
        result: {
          message: msg,
          ticket: toTicketDto(fresh, user.role),
          replayed: false,
          spawnedFrom: row.id,
        },
      };
    }

    // staff may set pending/resolved together with a public reply; validate against the status AFTER the automatic effect
    const afterReply = outcome.type === 'set' ? outcome.status : row.status;
    let target = outcome.type === 'set' ? outcome.status : undefined;
    if (input.setStatus && input.setStatus !== afterReply) {
      if (!canTransition(afterReply, input.setStatus, user.role)) {
        throw appError(
          409,
          'invalid_transition',
          `Cannot change status from ${afterReply} to ${input.setStatus}`,
        );
      }
      target = input.setStatus;
    }

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO messages (ticket_id, author_id, client_id, kind, body, created_at)
      VALUES (${ticketId}, ${user.id}, ${input.id}, ${input.kind}, ${input.body}, ${now}) RETURNING id`);
    const messageId = inserted.rows[0]?.id;
    if (!messageId) throw new Error('message insert returned nothing');
    if (!(await linkAttachments(tx, user.id, messageId, input.attachmentIds))) {
      throw appError(
        400,
        'validation_error',
        'Some attachments do not exist, are not yours, or are already used',
      );
    }

    const policies = await loadPolicies(tx);
    const extras: { last_public_message_at?: Date; first_responded_at?: Date } = {};
    if (input.kind === 'public') extras.last_public_message_at = now;
    if (input.kind === 'public' && isStaff(user.role) && row.first_responded_at === null)
      extras.first_responded_at = now;
    const applied = await applyChanges(tx, {
      actor: user,
      row,
      changes: target ? { status: target } : {},
      policies,
      now,
      extras,
    });

    await emit(tx, 'message.created', ticketId, { messageId, kind: input.kind });
    if (user.role === 'customer' && applied.row.assignee_id) {
      await notify(tx, {
        userId: applied.row.assignee_id,
        type: 'customer_replied',
        ticketId,
        dedupeKey: `reply:${messageId}`,
      });
    }
    const msg = (await loadMessages(tx, ticketId, isStaff(user.role))).find(
      (m) => m.id === messageId,
    );
    if (!msg) throw new Error('inserted message not readable');
    return {
      created: true,
      result: {
        message: msg,
        ticket: toTicketDto(applied.row, user.role),
        replayed: false,
        spawnedFrom: null,
      },
    };
  });
};

export { ticketSelect, visibleTo };
export type { TicketRow };
