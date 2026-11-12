import { AUTO_CLOSE_AFTER_MS } from '@helpdesk/shared';
import type { Db } from '@helpdesk/db';
import { sql, type SQL } from 'drizzle-orm';
import type { Storage } from '../attachments/storage';
import type { Logger } from '../lib/logger';
import { emit } from '../tickets/history';
import { readTickets, ticketSelect } from '../tickets/model';
import { applyChanges, loadPolicies } from '../tickets/mutate';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type JobContext = { db: Db; storage: Storage; logger: Logger; now: () => Date };
export type Handler = (ctx: JobContext) => Promise<unknown>;

const WARN_BEFORE_MIN = 30;
const SYSTEM_VIEWER = { id: '00000000-0000-0000-0000-000000000000', role: 'lead' } as never;

/**
 * Marks one kind of SLA event, EXACTLY ONCE per ticket: the UPDATE only touches rows whose mark is still NULL,
 * and the notification insert is deduplicated, so overlapping or repeated runs never notify twice.
 */
const mark = async (
  ctx: JobContext,
  o: {
    column:
      | 'first_response_warned_at'
      | 'resolution_warned_at'
      | 'first_response_breached_at'
      | 'resolution_breached_at';
    value: SQL;
    where: SQL;
    type: 'sla_warning' | 'sla_breached';
    key: string;
  },
): Promise<number> =>
  ctx.db.transaction(async (tx) => {
    const marked = await tx.execute<{ id: string; assignee_id: string | null }>(sql`
      UPDATE tickets SET ${sql.raw(o.column)} = ${o.value}
      WHERE ${sql.raw(o.column)} IS NULL AND ${o.where}
      RETURNING id, assignee_id`);
    for (const t of marked.rows) {
      if (t.assignee_id) {
        const n = await tx.execute<{ id: string }>(sql`
          INSERT INTO notifications (user_id, type, ticket_id, dedupe_key) VALUES (${t.assignee_id}, ${o.type}, ${t.id}, ${o.key})
          ON CONFLICT (user_id, ticket_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`);
        const id = n.rows[0]?.id;
        if (id)
          await emit(
            tx,
            'notification.created',
            t.id,
            { notificationId: id, kind: o.type },
            t.assignee_id,
          );
      }
      await emit(tx, 'ticket.changed', t.id, { changed: ['sla'] }); // list views refresh their "breached" flag
    }
    return marked.rows.length;
  });

/**
 * Warns the assignee 30 minutes before a deadline and marks breaches. Only tickets whose clock RUNS (new/open):
 * `pending` is paused, `resolved`/`closed` are done. A breach is stamped with the deadline itself.
 */
export const slaScan: Handler = async (ctx) => {
  const now = ctx.now();
  const warnAt = (col: string) =>
    sql`${now} >= ${sql.raw(col)} - make_interval(mins => ${WARN_BEFORE_MIN}) AND ${now} <= ${sql.raw(col)}`;
  const running = sql`status IN ('new', 'open')`;
  const counts = {
    firstWarned: await mark(ctx, {
      column: 'first_response_warned_at',
      value: sql`${now}`,
      type: 'sla_warning',
      key: 'first_response_warning',
      where: sql`${running} AND first_responded_at IS NULL AND first_response_breached_at IS NULL AND ${warnAt('first_response_due')}`,
    }),
    firstBreached: await mark(ctx, {
      column: 'first_response_breached_at',
      value: sql`first_response_due`,
      type: 'sla_breached',
      key: 'first_response_breach',
      where: sql`${running} AND first_responded_at IS NULL AND ${now} > first_response_due`,
    }),
    resolutionWarned: await mark(ctx, {
      column: 'resolution_warned_at',
      value: sql`${now}`,
      type: 'sla_warning',
      key: 'resolution_warning',
      where: sql`${running} AND resolved_at IS NULL AND resolution_breached_at IS NULL AND ${warnAt('resolution_due')}`,
    }),
    resolutionBreached: await mark(ctx, {
      column: 'resolution_breached_at',
      value: sql`resolution_due`,
      type: 'sla_breached',
      key: 'resolution_breach',
      where: sql`${running} AND resolved_at IS NULL AND ${now} > resolution_due`,
    }),
  };
  return counts;
};

/** `resolved` for 3 days with no customer reply → `closed` (a customer reply reopens the ticket, so it drops out of the query). */
export const autoClose: Handler = async (ctx) => {
  const cutoff = new Date(ctx.now().getTime() - AUTO_CLOSE_AFTER_MS);
  let closed = 0;
  for (let batch = 0; batch < 20; batch += 1) {
    const n = await ctx.db.transaction(async (tx) => {
      const due = await tx.execute<{ id: string }>(sql`
        SELECT id FROM tickets WHERE status = 'resolved' AND resolved_at <= ${cutoff}
        ORDER BY resolved_at, id LIMIT 100 FOR UPDATE SKIP LOCKED`);
      if (due.rows.length === 0) return 0;
      const policies = await loadPolicies(tx);
      for (const { id } of due.rows) {
        const row = (
          await readTickets(
            tx,
            sql`${ticketSelect(SYSTEM_VIEWER)} WHERE t.id = ${id} FOR UPDATE OF t`,
          )
        )[0];
        if (row && row.status === 'resolved') {
          await applyChanges(tx, {
            actor: null,
            row,
            changes: { status: 'closed' },
            policies,
            now: ctx.now(),
          });
        }
      }
      return due.rows.length;
    });
    closed += n;
    if (n < 100) break;
  }
  return { closed };
};

/** Attachments uploaded but never sent are deleted after 24 h (row first, then the file). Also sweeps stale temp files. */
export const orphanAttachments: Handler = async (ctx) => {
  const cutoff = new Date(ctx.now().getTime() - 24 * 3_600_000);
  let removed = 0;
  for (;;) {
    const r = await ctx.db.execute<{ storage_key: string }>(sql`
      DELETE FROM attachments WHERE id IN (SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ${cutoff} LIMIT 500)
      RETURNING storage_key`);
    for (const row of r.rows) await ctx.storage.remove(row.storage_key);
    removed += r.rows.length;
    if (r.rows.length < 500) break;
  }
  let temp = 0;
  try {
    for (const name of await readdir(ctx.storage.root)) {
      if (!name.startsWith('.tmp-')) continue;
      const file = path.join(ctx.storage.root, name);
      if (ctx.now().getTime() - (await stat(file)).mtimeMs > 3_600_000) {
        await rm(file, { force: true });
        temp += 1;
      }
    }
  } catch {
    /* directory missing or racing with an upload: nothing to sweep */
  }
  return { removed, temp };
};

/** Keeps the small bookkeeping tables small. */
export const housekeeping: Handler = async (ctx) => {
  const now = ctx.now();
  const day = new Date(now.getTime() - 24 * 3_600_000);
  const week = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const q = async (query: SQL) => (await ctx.db.execute(query)).rowCount ?? 0;
  return {
    rateLimits: await q(
      sql`DELETE FROM rate_limits WHERE window_start < ${new Date(now.getTime() - 3_600_000)}`,
    ),
    presence: await q(sql`DELETE FROM ticket_presence WHERE expires_at < ${now}`),
    events: await q(sql`DELETE FROM event_log WHERE created_at < ${day}`),
    jobs: await q(sql`DELETE FROM jobs WHERE status = 'done' AND finished_at < ${week}`),
    sessions: await q(sql`DELETE FROM sessions WHERE expires_at < ${now}`),
  };
};

/** Recurring jobs: type → handler + interval. Exactly one instance of each is ever queued (dedupe key). */
export const RECURRING: Readonly<Record<string, { handler: Handler; everySeconds: number }>> = {
  'sla-scan': { handler: slaScan, everySeconds: 60 },
  'auto-close': { handler: autoClose, everySeconds: 60 },
  'orphan-attachments': { handler: orphanAttachments, everySeconds: 600 },
  housekeeping: { handler: housekeeping, everySeconds: 300 },
};
