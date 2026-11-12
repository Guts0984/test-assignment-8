import { sql } from 'drizzle-orm';
import type { Tx } from './db';

export type HistoryField = 'created' | 'status' | 'priority' | 'assignee' | 'category' | 'tags';

/** "Who changed what and when": one row per changed field. actor NULL = the system. */
export const recordEvent = async (
  tx: Tx,
  e: {
    ticketId: string;
    actorId: string | null;
    field: HistoryField;
    oldValue: string | null;
    newValue: string | null;
    at?: Date;
  },
): Promise<void> => {
  await tx.execute(
    sql`INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, created_at)
        VALUES (${e.ticketId}, ${e.actorId}, ${e.field}, ${e.oldValue}, ${e.newValue}, ${e.at ?? new Date()})`,
  );
};

/**
 * Durable log behind SSE. The payload carries IDs only; WHO may receive an event is decided at delivery
 * time from the viewer's permissions, so a note or a foreign ticket can never leak through the stream.
 * `targetUserId` narrows an event to one user (notifications). pg_notify wakes the dispatcher at COMMIT.
 */
export const emit = async (
  tx: Tx,
  type: string,
  ticketId: string | null,
  payload: Record<string, unknown>,
  targetUserId: string | null = null,
): Promise<void> => {
  const r = await tx.execute<{ id: string }>(
    sql`INSERT INTO event_log (type, ticket_id, target_user_id, payload) VALUES (${type}, ${ticketId}, ${targetUserId}, ${JSON.stringify(payload)}::jsonb) RETURNING id`,
  );
  const id = r.rows[0]?.id;
  if (id) await tx.execute(sql`SELECT pg_notify('helpdesk_events', ${String(id)})`);
};

export type NotificationType = 'assigned' | 'customer_replied' | 'sla_warning' | 'sla_breached';

export const notify = async (
  tx: Tx,
  n: { userId: string; type: NotificationType; ticketId: string; dedupeKey: string },
): Promise<void> => {
  const r = await tx.execute<{ id: string }>(
    sql`INSERT INTO notifications (user_id, type, ticket_id, dedupe_key)
        VALUES (${n.userId}, ${n.type}, ${n.ticketId}, ${n.dedupeKey})
        ON CONFLICT (user_id, ticket_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id`,
  );
  const id = r.rows[0]?.id;
  if (id)
    await emit(
      tx,
      'notification.created',
      n.ticketId,
      { notificationId: id, kind: n.type },
      n.userId,
    );
};
