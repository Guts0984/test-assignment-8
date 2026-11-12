import type { ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { createListener, type Db } from '@helpdesk/db';
import type { SseEvent } from '@helpdesk/shared';
import type { Logger } from '../lib/logger';
import type { SessionUser } from '../lib/sessions';
import { isStaff, visibleTo } from '../tickets/model';

export type Connection = {
  id: number;
  user: SessionUser;
  clientKey: string;
  res: ServerResponse;
  /** hash of the session token that opened the stream (logout closes exactly these streams) */
  sessionId?: string;
};

type EventRow = {
  id: string;
  type: string;
  ticket_id: string | null;
  target_user_id: string | null;
  payload: Record<string, unknown>;
};

const MAX_BUFFERED_BYTES = 1_000_000;

/** One SSE frame. `id` lets the browser resume with Last-Event-ID. */
const frame = (id: string, event: SseEvent): string =>
  `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * Fans the durable event log out to open SSE connections.
 * Permission is checked PER CONNECTION AND PER EVENT at delivery time (not when the event was written), so a customer
 * never receives internal-note events, events of other customers' tickets, or anything about tickets they lost access to.
 */
export const createRealtime = (opts: {
  db: Db;
  databaseUrl: string;
  logger: Logger;
  pollMs?: number;
}) => {
  const conns = new Map<number, Connection>();
  let nextId = 1;
  let lastSeen = 0n;
  let listener: ReturnType<typeof createListener> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let pumping: Promise<void> = Promise.resolve();
  let again = false;

  const visibleTicketIds = async (user: SessionUser, ticketIds: string[]): Promise<Set<string>> => {
    if (ticketIds.length === 0) return new Set();
    const list = sql.join(
      ticketIds.map((i) => sql`${i}::uuid`),
      sql`, `,
    );
    const r = await opts.db.execute<{ id: string }>(
      sql`SELECT t.id FROM tickets t WHERE t.id IN (${list}) AND ${visibleTo(user)}`,
    );
    return new Set(r.rows.map((x) => x.id));
  };

  const toSse = (
    e: EventRow,
    number: number | undefined,
    users: Map<string, string>,
  ): SseEvent | null => {
    const p = e.payload;
    switch (e.type) {
      case 'ticket.created':
        return e.ticket_id ? { type: 'ticket.created', ticketId: e.ticket_id } : null;
      case 'ticket.changed':
        return e.ticket_id
          ? {
              type: 'ticket.changed',
              ticketId: e.ticket_id,
              ...(typeof p.version === 'number' ? { version: p.version } : {}),
              changed: Array.isArray(p.changed) ? (p.changed as string[]) : [],
            }
          : null;
      case 'message.created':
        return e.ticket_id && typeof p.messageId === 'string'
          ? {
              type: 'message.created',
              ticketId: e.ticket_id,
              messageId: p.messageId,
              kind: p.kind === 'internal' ? 'internal' : 'public',
            }
          : null;
      case 'notification.created':
        return e.ticket_id && typeof p.notificationId === 'string' && number !== undefined
          ? {
              type: 'notification.created',
              notificationId: p.notificationId,
              kind: p.kind as 'assigned',
              ticketId: e.ticket_id,
              number: `HD-${number}`,
            }
          : null;
      case 'presence':
        return e.ticket_id && typeof p.userId === 'string'
          ? {
              type: 'presence',
              ticketId: e.ticket_id,
              userId: p.userId,
              name: users.get(p.userId) ?? String(p.name ?? ''),
              typing: p.typing === true,
            }
          : null;
      default:
        return null;
    }
  };

  const write = (c: Connection, data: string): void => {
    if (c.res.destroyed || c.res.writableEnded) return;
    if (c.res.writableLength > MAX_BUFFERED_BYTES) {
      c.res.destroy(); // a client that cannot keep up is dropped instead of growing our memory
      return;
    }
    c.res.write(data);
  };

  /** Delivers `events` to `targets`, applying every permission rule. Used for live events AND for Last-Event-ID replay. */
  const deliver = async (events: EventRow[], targets: Connection[]): Promise<void> => {
    if (events.length === 0 || targets.length === 0) return;
    const ticketIds = [...new Set(events.flatMap((e) => (e.ticket_id ? [e.ticket_id] : [])))];
    const numbers = new Map<string, number>();
    if (ticketIds.length) {
      const list = sql.join(
        ticketIds.map((i) => sql`${i}::uuid`),
        sql`, `,
      );
      for (const r of (
        await opts.db.execute<{ id: string; number: number }>(
          sql`SELECT id, number FROM tickets WHERE id IN (${list})`,
        )
      ).rows)
        numbers.set(r.id, r.number);
    }
    const userNames = new Map<string, string>();
    const presenceUsers = [
      ...new Set(
        events
          .filter((e) => e.type === 'presence')
          .flatMap((e) => (typeof e.payload.userId === 'string' ? [e.payload.userId] : [])),
      ),
    ];
    if (presenceUsers.length) {
      const list = sql.join(
        presenceUsers.map((i) => sql`${i}::uuid`),
        sql`, `,
      );
      for (const r of (
        await opts.db.execute<{ id: string; name: string }>(
          sql`SELECT id, name FROM users WHERE id IN (${list})`,
        )
      ).rows)
        userNames.set(r.id, r.name);
    }
    for (const c of targets) {
      const visible = await visibleTicketIds(c.user, ticketIds);
      for (const e of events) {
        if (e.target_user_id !== null && e.target_user_id !== c.user.id) continue; // personal events
        if (e.ticket_id && !visible.has(e.ticket_id)) continue; // no access to that ticket
        if (e.type === 'message.created' && e.payload.kind === 'internal' && !isStaff(c.user.role))
          continue; // internal notes: staff only
        if (e.type === 'presence' && !isStaff(c.user.role)) continue; // "who is typing" is staff-only
        const sse = toSse(e, e.ticket_id ? numbers.get(e.ticket_id) : undefined, userNames);
        if (sse) write(c, frame(e.id, sse));
      }
    }
  };

  const fetchEvents = async (
    afterId: bigint,
    limit: number,
    sinceMinutes?: number,
  ): Promise<EventRow[]> =>
    (
      await opts.db.execute<EventRow>(sql`
        SELECT id, type, ticket_id, target_user_id, payload FROM event_log
        WHERE id > ${afterId.toString()}::bigint ${sinceMinutes ? sql`AND created_at > now() - make_interval(mins => ${sinceMinutes})` : sql``}
        ORDER BY id LIMIT ${limit}`)
    ).rows;

  const pump = (): Promise<void> => {
    // serialise: notifications arriving while we deliver are folded into one more pass
    if (stopped) return pumping;
    again = true;
    pumping = pumping.then(async () => {
      while (again && !stopped) {
        again = false;
        try {
          const events = await fetchEvents(lastSeen, 500);
          if (events.length === 0) continue;
          const last = events[events.length - 1];
          if (last) lastSeen = BigInt(last.id);
          await deliver(events, [...conns.values()]);
          if (events.length === 500) again = true;
        } catch (err) {
          opts.logger.warn('realtime pump failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
    return pumping;
  };

  const connectListener = async (): Promise<void> => {
    if (stopped) return;
    const client = createListener(opts.databaseUrl);
    client.on('error', () => undefined);
    client.on('notification', () => void pump());
    client.on('end', () => {
      if (!stopped) setTimeout(() => void connectListener(), 1_000).unref(); // reconnect; the poll below covers the gap
    });
    try {
      await client.connect();
      await client.query('LISTEN helpdesk_events');
      listener = client;
    } catch {
      client.end().catch(() => undefined);
      if (!stopped) setTimeout(() => void connectListener(), 1_000).unref();
    }
  };

  return {
    start: async (): Promise<void> => {
      const max = await opts.db.execute<{ id: string | null }>(
        sql`SELECT max(id) AS id FROM event_log`,
      );
      lastSeen = BigInt(max.rows[0]?.id ?? 0); // live events only; older ones are what Last-Event-ID replay is for
      await connectListener();
      // safety net: LISTEN can miss events while it reconnects
      timer = setInterval(() => void pump(), opts.pollMs ?? 3_000);
      timer.unref();
    },
    add: (
      user: SessionUser,
      clientKey: string,
      res: ServerResponse,
      sessionId?: string,
    ): Connection => {
      const c: Connection = {
        id: nextId++,
        user,
        clientKey,
        res,
        ...(sessionId ? { sessionId } : {}),
      };
      conns.set(c.id, c);
      return c;
    },
    remove: (c: Connection): void => void conns.delete(c.id),
    /** Ends every stream opened with this session (called on logout; other instances notice at their next heartbeat). */
    closeSession: (sessionId: string): number => {
      let n = 0;
      for (const c of [...conns.values()]) {
        if (c.sessionId !== sessionId) continue;
        conns.delete(c.id);
        c.res.end();
        n += 1;
      }
      return n;
    },
    countFor: (userId: string): number =>
      [...conns.values()].filter((c) => c.user.id === userId).length,
    countForClient: (key: string): number =>
      [...conns.values()].filter((c) => c.clientKey === key).length,
    size: (): number => conns.size,
    /** Replays what a reconnecting client missed (last hour, at most 1000 events), with the same permission rules. */
    replay: async (c: Connection, afterId: bigint): Promise<void> =>
      deliver(await fetchEvents(afterId, 1_000, 60), [c]),
    write,
    /** Graceful shutdown: end every stream, stop listening. */
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const c of conns.values()) if (!c.res.writableEnded) c.res.end();
      conns.clear();
      await pumping.catch(() => undefined);
      await listener?.end().catch(() => undefined);
    },
  };
};
export type Realtime = ReturnType<typeof createRealtime>;
