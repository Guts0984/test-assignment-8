import type { DbHandle } from '@helpdesk/db';
import type { BulkRequest, BulkResult, TicketDto } from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import { appError } from '../lib/errors';
import type { SessionUser } from '../lib/sessions';
import { authorizeChanges } from './authorize';
import { toTicketDto } from './model';
import { applyChanges, fetchTicket, loadPolicies, type Changes } from './mutate';
import { isEligibleAssignee } from './service';

/**
 * "Take next": the most urgent free ticket of the agent's categories, assigned atomically.
 * FOR UPDATE SKIP LOCKED means simultaneous callers each lock a DIFFERENT row instead of queueing on one.
 */
export const takeNext = async (db: DbHandle, user: SessionUser): Promise<TicketDto> => {
  if (user.role === 'agent' && user.categories.length === 0)
    throw appError(404, 'not_found', 'No tickets available');
  return db.db.transaction(async (tx) => {
    const cats =
      user.role === 'lead'
        ? sql`true`
        : sql`t.category IN (${sql.join(
            user.categories.map((c) => sql`${c}`),
            sql`, `,
          )})`;
    const next = await tx.execute<{ id: string }>(sql`
      SELECT t.id FROM tickets t
      WHERE t.assignee_id IS NULL AND t.status IN ('new', 'open') AND ${cats}
      ORDER BY t.priority DESC, t.sla_due_at ASC NULLS LAST, t.created_at ASC, t.id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`);
    const id = next.rows[0]?.id;
    if (!id) throw appError(404, 'not_found', 'No tickets available');
    const row = await fetchTicket(tx, user, id, { lock: true });
    if (!row) throw appError(404, 'not_found', 'No tickets available');
    const policies = await loadPolicies(tx);
    const res = await applyChanges(tx, {
      actor: user,
      row,
      changes: { assigneeId: user.id },
      policies,
      now: new Date(),
    });
    return toTicketDto(res.row, user.role);
  });
};

const nextTags = (
  current: readonly string[],
  op: Extract<BulkRequest['operation'], { action: 'setTags' }>,
): string[] => {
  if (op.mode === 'replace') return [...op.tags];
  if (op.mode === 'add') return [...new Set([...current, ...op.tags])];
  const drop = new Set(op.tags);
  return current.filter((t) => !drop.has(t));
};

/**
 * Up to 200 tickets, each handled in its OWN transaction so one failure never rolls back the rest.
 * The answer lists every id with ok / the reason it was skipped, in request order.
 */
export const bulkApply = async (
  db: DbHandle,
  user: SessionUser,
  req: BulkRequest,
): Promise<BulkResult> => {
  const eligible =
    req.operation.action === 'assign' && typeof req.operation.assigneeId === 'string'
      ? await isEligibleAssignee(db.db, req.operation.assigneeId)
      : true;
  const results: BulkResult['results'] = [];
  for (const id of req.ids) {
    {
      const outcome = await db.db.transaction(async (tx) => {
        const row = await fetchTicket(tx, user, id, { lock: true });
        if (!row) return { ok: false as const, reason: 'not_found_or_forbidden' as const };
        const op = req.operation;
        const changes: Changes =
          op.action === 'assign'
            ? { assigneeId: op.assigneeId }
            : op.action === 'setStatus'
              ? { status: op.status }
              : op.action === 'setPriority'
                ? { priority: op.priority }
                : { tags: nextTags(row.tags, op) };
        const denied = authorizeChanges(user, row, changes, eligible);
        if (denied) return { ok: false as const, reason: denied.reason };
        const policies = await loadPolicies(tx);
        const res = await applyChanges(tx, {
          actor: user,
          row,
          changes,
          policies,
          now: new Date(),
        });
        return res.changed.length === 0
          ? { ok: false as const, reason: 'unchanged' as const }
          : { ok: true as const };
      });
      results.push(outcome.ok ? { id, ok: true } : { id, ok: false, reason: outcome.reason });
    }
  }
  return { results };
};
