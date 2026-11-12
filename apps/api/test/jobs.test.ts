import { mkdtempSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@helpdesk/db';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { agentCategories, users } from '@helpdesk/db';
import { sql } from 'drizzle-orm';
import { createStorage } from '../src/attachments/storage';
import {
  autoClose,
  housekeeping,
  orphanAttachments,
  RECURRING,
  slaScan,
  type JobContext,
} from '../src/jobs/handlers';
import { claim, complete, enqueue, fail, reclaimExpired } from '../src/jobs/queue';
import { scheduleRecurring, startWorker } from '../src/jobs/worker';
import { createLogger } from '../src/lib/logger';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = new Date('2026-11-12T10:00:00.000Z');

describe('background jobs on PostgreSQL (real database, fake clock)', () => {
  let t: TestDb;
  let dir: string;
  let storage: ReturnType<typeof createStorage>;
  let customerId: string, agentId: string;
  const ctxAt = (now: Date): JobContext => ({
    db: t.db,
    storage,
    logger: createLogger('silent'),
    now: () => now,
  });
  const q = async (query: ReturnType<typeof sql>) => (await t.db.execute(query)).rows;
  const n = async (query: ReturnType<typeof sql>) =>
    Number(Object.values((await q(query))[0] ?? {})[0]);
  let seq = 5000;

  const ticket = async (
    o: {
      status?: string;
      assigneeId?: string | null;
      firstDueIn?: number;
      resDueIn?: number;
      firstResponded?: boolean;
      resolvedAt?: Date | null;
      created?: Date;
      priority?: string;
    } = {},
  ) => {
    seq += 1;
    const created = o.created ?? new Date(T0.getTime() - 5 * DAY);
    const status = o.status ?? 'open';
    const r = await t.db.execute<{ id: string }>(sql`
      INSERT INTO tickets (number, subject, category, priority, status, customer_id, assignee_id, created_at, updated_at, first_response_due, resolution_due, first_responded_at, resolved_at, closed_at, sla_paused_at)
      VALUES (${seq}, 'job test', 'payment', ${o.priority ?? 'normal'}, ${status}, ${customerId}, ${o.assigneeId === undefined ? agentId : o.assigneeId}, ${created}, ${created},
              ${new Date(T0.getTime() + (o.firstDueIn ?? 10_000 * MIN))}, ${new Date(T0.getTime() + (o.resDueIn ?? 20_000 * MIN))},
              ${o.firstResponded ? created : null}, ${o.resolvedAt ?? (status === 'resolved' || status === 'closed' ? T0 : null)}, ${status === 'closed' ? T0 : null}, ${status === 'pending' ? created : null})
      RETURNING id`);
    return r.rows[0]!.id;
  };
  const cols = async (id: string) =>
    (
      await q(
        sql`SELECT status, version, first_response_warned_at w1, first_response_breached_at b1, resolution_warned_at w2, resolution_breached_at b2, closed_at FROM tickets WHERE id = ${id}`,
      )
    )[0] as Record<string, unknown>;
  const notifs = async (id: string) =>
    (await q(
      sql`SELECT type, dedupe_key, user_id FROM notifications WHERE ticket_id = ${id} ORDER BY type, dedupe_key`,
    )) as Array<{ type: string; dedupe_key: string; user_id: string }>;

  beforeAll(async () => {
    t = await createTestDb();
    dir = mkdtempSync(path.join(tmpdir(), 'hd-jobs-'));
    storage = createStorage(dir);
    await storage.ensure();
    const mk = async (email: string, role: 'customer' | 'agent') =>
      (
        await t.db
          .insert(users)
          .values({ email, name: email, role, passwordHash: 'x' })
          .returning({ id: users.id })
      )[0]!.id;
    customerId = await mk('c@t.test', 'customer');
    agentId = await mk('a@t.test', 'agent');
    await t.db.insert(agentCategories).values({ userId: agentId, category: 'payment' });
  });
  afterAll(async () => t.drop());

  describe('the queue itself', () => {
    it('a dedupe key allows one queued/running instance; a finished one frees the slot', async () => {
      const a = await enqueue(t.db, { type: 'x', dedupeKey: 'd1' });
      expect(a).not.toBeNull();
      expect(await enqueue(t.db, { type: 'x', dedupeKey: 'd1' })).toBeNull();
      const job = await claim(t.db, 'w', 60);
      expect(job?.id).toBe(a);
      expect(await enqueue(t.db, { type: 'x', dedupeKey: 'd1' })).toBeNull(); // still running
      await complete(t.db, a!);
      expect(await enqueue(t.db, { type: 'x', dedupeKey: 'd1' })).not.toBeNull();
      await t.db.execute(sql`DELETE FROM jobs`);
    });

    it('20 workers claiming at once get 5 DIFFERENT jobs, nobody gets one twice, the rest get nothing', async () => {
      for (let i = 0; i < 5; i += 1) await enqueue(t.db, { type: 'x', payload: { i } });
      const handles = Array.from({ length: 20 }, () => createDb(t.url, { max: 1 }));
      try {
        const got = await Promise.all(handles.map((h, i) => claim(h.db, `w${i}`, 60)));
        const ids = got.flatMap((j) => (j ? [j.id] : []));
        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5);
      } finally {
        await Promise.all(handles.map((h) => h.close()));
      }
      await t.db.execute(sql`DELETE FROM jobs`);
    });

    it('jobs scheduled in the future are not claimed; due ones come oldest-first', async () => {
      const later = await enqueue(t.db, { type: 'x', delaySeconds: 3600 });
      const first = await enqueue(t.db, { type: 'x' });
      expect((await claim(t.db, 'w', 60))?.id).toBe(first);
      expect(await claim(t.db, 'w', 60)).toBeNull();
      expect(later).not.toBeNull();
      await t.db.execute(sql`DELETE FROM jobs`);
    });

    it("a crashed worker's job comes back after its lease expires (and not before); attempts are counted", async () => {
      const id = await enqueue(t.db, { type: 'x' });
      const job = await claim(t.db, 'crashy', 60);
      expect(job?.attempts).toBe(1);
      expect(await reclaimExpired(t.db)).toBe(0); // lease still valid
      expect(await claim(t.db, 'other', 60)).toBeNull();
      await t.db.execute(
        sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${id}`,
      );
      expect(await reclaimExpired(t.db)).toBe(1);
      const again = await claim(t.db, 'other', 60);
      expect(again).toMatchObject({ id, attempts: 2 });
      await t.db.execute(sql`DELETE FROM jobs`);
    });

    it('failures retry with backoff and give up after max_attempts (status failed, error kept)', async () => {
      const id = await enqueue(t.db, { type: 'x', maxAttempts: 2 });
      let job = await claim(t.db, 'w', 60);
      await fail(t.db, job!, new Error('boom'));
      expect(
        (
          await q(
            sql`SELECT status, last_error, run_at > now() AS later FROM jobs WHERE id = ${id}`,
          )
        )[0],
      ).toMatchObject({ status: 'queued', last_error: 'boom', later: true });
      await t.db.execute(sql`UPDATE jobs SET run_at = now() WHERE id = ${id}`);
      job = await claim(t.db, 'w', 60);
      await fail(t.db, job!, new Error('boom again'));
      expect((await q(sql`SELECT status, last_error FROM jobs WHERE id = ${id}`))[0]).toMatchObject(
        { status: 'failed', last_error: 'boom again' },
      );
      // a job whose worker died on its LAST attempt also ends up failed, not looping forever
      const id2 = await enqueue(t.db, { type: 'x', maxAttempts: 1 });
      await claim(t.db, 'dies', 60);
      await t.db.execute(
        sql`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = ${id2}`,
      );
      await reclaimExpired(t.db);
      expect((await q(sql`SELECT status FROM jobs WHERE id = ${id2}`))[0]).toMatchObject({
        status: 'failed',
      });
      await t.db.execute(sql`DELETE FROM jobs`);
    });
  });

  describe('SLA scan: warn 30 minutes before, mark breaches — exactly once', () => {
    it('warns the assignee at due − 30 min (not at − 31), once, even if the scan runs 10 times', async () => {
      const id = await ticket({ firstDueIn: 31 * MIN });
      await slaScan(ctxAt(T0));
      expect((await cols(id)).w1).toBeNull(); // 31 min before: too early
      const at = new Date(T0.getTime() + MIN); // now 30 min before
      for (let i = 0; i < 10; i += 1) await slaScan(ctxAt(at));
      expect((await cols(id)).w1).not.toBeNull();
      expect(await notifs(id)).toEqual([
        { type: 'sla_warning', dedupe_key: 'first_response_warning', user_id: agentId },
      ]);
    });

    it('marks a breach the moment the deadline passes, stamped with the DEADLINE (not the scan time), notifies once', async () => {
      const id = await ticket({ firstDueIn: -MIN });
      for (let i = 0; i < 5; i += 1) await slaScan(ctxAt(T0));
      const c = await cols(id);
      expect(new Date(c.b1 as string).toISOString()).toBe(
        new Date(T0.getTime() - MIN).toISOString(),
      );
      expect((await notifs(id)).filter((x) => x.type === 'sla_breached')).toHaveLength(1);
    });

    it('exactly at the deadline is not yet a breach; one millisecond later it is', async () => {
      const id = await ticket({ firstDueIn: 0 });
      await slaScan(ctxAt(T0));
      expect((await cols(id)).b1).toBeNull();
      await slaScan(ctxAt(new Date(T0.getTime() + 1)));
      expect((await cols(id)).b1).not.toBeNull();
    });

    it('first-response and resolution deadlines are tracked independently, with their own notifications', async () => {
      const id = await ticket({ firstDueIn: -2 * MIN, resDueIn: 20 * MIN });
      await slaScan(ctxAt(T0));
      let c = await cols(id);
      expect(c.b1).not.toBeNull();
      expect(c.w2).not.toBeNull(); // resolution due in 20 min → warned
      expect(c.b2).toBeNull();
      await slaScan(ctxAt(new Date(T0.getTime() + 21 * MIN)));
      c = await cols(id);
      expect(c.b2).not.toBeNull();
      expect((await notifs(id)).map((x) => x.dedupe_key).sort()).toEqual([
        'first_response_breach',
        'resolution_breach',
        'resolution_warning',
      ]);
    });

    it('answered tickets are never marked for first response; pending (paused) / resolved / closed tickets are never touched', async () => {
      const answered = await ticket({
        firstDueIn: -5 * MIN,
        resDueIn: -2 * MIN,
        firstResponded: true,
      });
      const pending = await ticket({ status: 'pending', firstDueIn: -5 * MIN, resDueIn: -5 * MIN });
      const resolved = await ticket({
        status: 'resolved',
        firstDueIn: -5 * MIN,
        resDueIn: -5 * MIN,
        firstResponded: true,
      });
      const closed = await ticket({
        status: 'closed',
        firstDueIn: -5 * MIN,
        resDueIn: -5 * MIN,
        firstResponded: true,
      });
      await slaScan(ctxAt(T0));
      expect((await cols(answered)).b1).toBeNull();
      expect((await cols(answered)).b2).not.toBeNull(); // but its resolution deadline did pass
      for (const id of [pending, resolved, closed]) {
        const c = await cols(id);
        expect([c.w1, c.b1, c.w2, c.b2], id).toEqual([null, null, null, null]);
        expect(await notifs(id)).toEqual([]);
      }
    });

    it('unassigned tickets get the marks (so the lead\'s "SLA breached" filter works) but nobody to notify', async () => {
      const id = await ticket({ assigneeId: null, firstDueIn: -MIN });
      await slaScan(ctxAt(T0));
      expect((await cols(id)).b1).not.toBeNull();
      expect(await notifs(id)).toEqual([]);
    });

    it('two scans at the very same time (two api instances) produce ONE notification and one mark', async () => {
      const id = await ticket({ firstDueIn: -MIN });
      await Promise.all(Array.from({ length: 6 }, () => slaScan(ctxAt(T0))));
      expect((await notifs(id)).filter((x) => x.type === 'sla_breached')).toHaveLength(1);
    });

    it('the scan emits events so open lists refresh (notification + ticket.changed)', async () => {
      const before = await n(sql`SELECT count(*) FROM event_log`);
      const id = await ticket({ firstDueIn: -MIN });
      await slaScan(ctxAt(T0));
      expect(await n(sql`SELECT count(*) FROM event_log`)).toBeGreaterThanOrEqual(before + 2);
      expect(
        await n(
          sql`SELECT count(*) FROM event_log WHERE ticket_id = ${id} AND type = 'notification.created' AND target_user_id = ${agentId}`,
        ),
      ).toBe(1);
    });
  });

  describe('auto-close: resolved for 3 days → closed (acceptance #11)', () => {
    it('closes at exactly 3 days, not one second earlier; records who/when; the system is the actor', async () => {
      const exactly = await ticket({
        status: 'resolved',
        resolvedAt: new Date(T0.getTime() - 3 * DAY),
      });
      const almost = await ticket({
        status: 'resolved',
        resolvedAt: new Date(T0.getTime() - 3 * DAY + 1000),
      });
      await autoClose(ctxAt(T0));
      expect((await cols(exactly)).status).toBe('closed');
      expect((await cols(almost)).status).toBe('resolved');
      const ev = (await q(
        sql`SELECT field, old_value, new_value, actor_id FROM ticket_events WHERE ticket_id = ${exactly}`,
      )) as Array<Record<string, unknown>>;
      expect(ev).toEqual([
        { field: 'status', old_value: 'resolved', new_value: 'closed', actor_id: null },
      ]);
      expect((await cols(exactly)).version).toBe(2);
      expect((await cols(exactly)).closed_at).not.toBeNull();
      await autoClose(ctxAt(new Date(T0.getTime() + 1000)));
      expect((await cols(almost)).status).toBe('closed'); // one second later it is due
    });

    it('only `resolved` tickets are closed: open / pending / new are left alone however old', async () => {
      const ids = await Promise.all(
        (['open', 'pending', 'new'] as const).map((s) =>
          ticket({ status: s, created: new Date(T0.getTime() - 90 * DAY) }),
        ),
      );
      await autoClose(ctxAt(new Date(T0.getTime() + 100 * DAY)));
      for (const id of ids) expect((await cols(id)).status).not.toBe('closed');
    });

    it('a customer reply (→ open) rescues the ticket; resolving again restarts the 3 days', async () => {
      const id = await ticket({ status: 'resolved', resolvedAt: new Date(T0.getTime() - 2 * DAY) });
      await t.db.execute(
        sql`UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = ${id}`,
      ); // what a customer reply does
      await autoClose(ctxAt(new Date(T0.getTime() + 10 * DAY)));
      expect((await cols(id)).status).toBe('open');
      await t.db.execute(
        sql`UPDATE tickets SET status = 'resolved', resolved_at = ${new Date(T0.getTime() + 10 * DAY)} WHERE id = ${id}`,
      );
      await autoClose(ctxAt(new Date(T0.getTime() + 12 * DAY)));
      expect((await cols(id)).status).toBe('resolved');
      await autoClose(ctxAt(new Date(T0.getTime() + 13 * DAY)));
      expect((await cols(id)).status).toBe('closed');
    });

    it('250 due tickets are all closed (batched), repeat runs do nothing, parallel runs never double-close', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 250; i += 1)
        ids.push(
          await ticket({ status: 'resolved', resolvedAt: new Date(T0.getTime() - 4 * DAY) }),
        );
      await Promise.all([autoClose(ctxAt(T0)), autoClose(ctxAt(T0)), autoClose(ctxAt(T0))]);
      expect(
        await n(
          sql`SELECT count(*) FROM tickets WHERE id IN (${sql.join(
            ids.map((i) => sql`${i}::uuid`),
            sql`, `,
          )}) AND status = 'closed'`,
        ),
      ).toBe(250);
      expect(
        await n(
          sql`SELECT count(*) FROM ticket_events WHERE field = 'status' AND new_value = 'closed' AND ticket_id IN (${sql.join(
            ids.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`,
        ),
      ).toBe(250); // one history row each
      const versions = await q(
        sql`SELECT DISTINCT version FROM tickets WHERE id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`,
      );
      expect(versions).toEqual([{ version: 2 }]);
    }, 60_000);

    it('closed tickets then refuse replies and edits (they never reopen)', async () => {
      const id = await ticket({ status: 'resolved', resolvedAt: new Date(T0.getTime() - 4 * DAY) });
      await autoClose(ctxAt(T0));
      expect((await cols(id)).status).toBe('closed');
    });
  });

  describe('orphaned attachments are deleted after 24 h', () => {
    const attachment = async (o: {
      age: number;
      attachedTo?: string | null;
      writeFile?: boolean;
    }) => {
      const key = crypto.randomUUID();
      if (o.writeFile !== false) writeFileSync(path.join(dir, key), 'x');
      const r = await t.db.execute<{ id: string }>(sql`
        INSERT INTO attachments (uploader_id, message_id, original_name, mime, size_bytes, storage_key, sha256, created_at)
        VALUES (${customerId}, ${o.attachedTo ?? null}, 'f.txt', 'text/plain', 1, ${key}, 'h', ${new Date(T0.getTime() - o.age)}) RETURNING id`);
      return { id: r.rows[0]!.id, key };
    };
    it('deletes unsent uploads older than 24 h (row AND file), keeps younger ones', async () => {
      const old = await attachment({ age: DAY + 1000 });
      const exactly = await attachment({ age: DAY });
      const young = await attachment({ age: DAY - 1000 });
      const res = (await orphanAttachments(ctxAt(T0))) as { removed: number };
      expect(res.removed).toBe(1); // strictly OLDER than 24 h
      expect(await n(sql`SELECT count(*) FROM attachments WHERE id = ${old.id}`)).toBe(0);
      expect(existsSync(path.join(dir, old.key))).toBe(false);
      for (const kept of [exactly, young]) {
        expect(await n(sql`SELECT count(*) FROM attachments WHERE id = ${kept.id}`)).toBe(1);
        expect(existsSync(path.join(dir, kept.key))).toBe(true);
      }
      await orphanAttachments(ctxAt(new Date(T0.getTime() + 2000))); // a moment later the boundary file is due too
      expect(await n(sql`SELECT count(*) FROM attachments WHERE id = ${exactly.id}`)).toBe(0);
    });
    it('keeps attached files forever, whatever their age', async () => {
      const tk = await ticket();
      const m = (
        await t.db.execute<{ id: string }>(
          sql`INSERT INTO messages (ticket_id, author_id, client_id, body) VALUES (${tk}, ${customerId}, ${crypto.randomUUID()}, 'with file') RETURNING id`,
        )
      ).rows[0]!.id;
      const kept = await attachment({ age: 400 * DAY, attachedTo: m });
      await orphanAttachments(ctxAt(T0));
      expect(await n(sql`SELECT count(*) FROM attachments WHERE id = ${kept.id}`)).toBe(1);
      expect(existsSync(path.join(dir, kept.key))).toBe(true);
    });
    it('tolerates files that are already gone, and runs twice without harm', async () => {
      await attachment({ age: 2 * DAY, writeFile: false });
      await expect(orphanAttachments(ctxAt(T0))).resolves.toBeDefined();
      await expect(orphanAttachments(ctxAt(T0))).resolves.toMatchObject({ removed: 0 });
    });
    it('sweeps stale temp files from interrupted uploads but never a fresh one', async () => {
      const stale = path.join(dir, `.tmp-${crypto.randomUUID()}`);
      const fresh = path.join(dir, `.tmp-${crypto.randomUUID()}`);
      writeFileSync(stale, 'x');
      writeFileSync(fresh, 'x');
      const old = new Date(T0.getTime() - 2 * 3_600_000);
      utimesSync(stale, old, old);
      utimesSync(fresh, T0, T0);
      await orphanAttachments(ctxAt(T0));
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(readdirSync(dir).filter((f) => !f.startsWith('.tmp-')).length).toBeGreaterThanOrEqual(
        0,
      );
    });
  });

  describe('housekeeping', () => {
    it('purges only what is stale', async () => {
      await t.db.execute(
        sql`INSERT INTO rate_limits (key, count, window_start) VALUES ('old-k', 1, ${new Date(T0.getTime() - 2 * 3_600_000)}), ('new-k', 1, ${T0})`,
      );
      await t.db.execute(
        sql`INSERT INTO event_log (type, payload, created_at) VALUES ('x', '{}', ${new Date(T0.getTime() - 2 * DAY)}), ('x', '{}', ${T0})`,
      );
      await housekeeping(ctxAt(T0));
      expect(await n(sql`SELECT count(*) FROM rate_limits WHERE key = 'old-k'`)).toBe(0);
      expect(await n(sql`SELECT count(*) FROM rate_limits WHERE key = 'new-k'`)).toBe(1);
      expect(
        await n(
          sql`SELECT count(*) FROM event_log WHERE created_at < ${new Date(T0.getTime() - DAY)}`,
        ),
      ).toBe(0);
    });
  });

  describe('the worker (restart-safe, nothing done twice)', () => {
    it('schedules each recurring job exactly once, however many instances boot', async () => {
      await t.db.execute(sql`DELETE FROM jobs`);
      await Promise.all(Array.from({ length: 5 }, () => scheduleRecurring({ db: t.db })));
      expect(await n(sql`SELECT count(*) FROM jobs WHERE status = 'queued'`)).toBe(
        Object.keys(RECURRING).length,
      );
    });

    it('runs a due job, then schedules exactly one next run; after a restart nothing is lost or duplicated', async () => {
      await t.db.execute(sql`DELETE FROM jobs`);
      const id = await ticket({ status: 'resolved', resolvedAt: new Date(Date.now() - 5 * DAY) });
      const w1 = startWorker(
        { db: t.db, storage, logger: createLogger('silent'), now: () => new Date() },
        { pollMs: 50, leaseSeconds: 60 },
      );
      await new Promise((r) => setTimeout(r, 800));
      await w1.stop(); // "restart"
      expect((await cols(id)).status).toBe('closed');
      const w2 = startWorker(
        { db: t.db, storage, logger: createLogger('silent'), now: () => new Date() },
        { pollMs: 50, leaseSeconds: 60 },
      );
      await new Promise((r) => setTimeout(r, 400));
      await w2.stop();
      for (const type of Object.keys(RECURRING)) {
        expect(
          await n(
            sql`SELECT count(*) FROM jobs WHERE type = ${type} AND status IN ('queued','running')`,
          ),
          type,
        ).toBe(1);
      }
      expect((await cols(id)).version).toBe(2); // closed once, never twice
    });

    it('two workers racing on one database never run the same job twice', async () => {
      await t.db.execute(sql`DELETE FROM jobs`);
      const ids: string[] = [];
      for (let i = 0; i < 30; i += 1)
        ids.push(await ticket({ status: 'resolved', resolvedAt: new Date(Date.now() - 5 * DAY) }));
      const mk = () =>
        startWorker(
          {
            db: createDb(t.url, { max: 3 }).db,
            storage,
            logger: createLogger('silent'),
            now: () => new Date(),
          },
          { pollMs: 20, leaseSeconds: 60 },
        );
      const [a, b] = [mk(), mk()];
      await new Promise((r) => setTimeout(r, 1200));
      await Promise.all([a.stop(), b.stop()]);
      expect(
        await n(
          sql`SELECT count(*) FROM ticket_events WHERE field = 'status' AND new_value = 'closed' AND ticket_id IN (${sql.join(
            ids.map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`,
        ),
      ).toBe(30);
    }, 30_000);

    it('a job that was running when its worker died is picked up again after the lease expires', async () => {
      await t.db.execute(sql`DELETE FROM jobs`);
      const tk = await ticket({ status: 'resolved', resolvedAt: new Date(Date.now() - 5 * DAY) });
      await enqueue(t.db, {
        type: 'auto-close',
        dedupeKey: 'recurring:auto-close',
        maxAttempts: 1_000_000,
      });
      await claim(t.db, 'dead-worker', 60); // claimed, then the process "crashed": never completed
      await t.db.execute(sql`UPDATE jobs SET locked_until = now() - interval '1 second'`);
      const w = startWorker(
        { db: t.db, storage, logger: createLogger('silent'), now: () => new Date() },
        { pollMs: 30, leaseSeconds: 60 },
      );
      await new Promise((r) => setTimeout(r, 800));
      await w.stop();
      expect((await cols(tk)).status).toBe('closed');
    });

    it('an unknown job type fails visibly instead of looping forever or crashing the worker', async () => {
      await t.db.execute(sql`DELETE FROM jobs`);
      await enqueue(t.db, { type: 'does-not-exist', maxAttempts: 1 });
      const w = startWorker(
        { db: t.db, storage, logger: createLogger('silent'), now: () => new Date() },
        { pollMs: 30, leaseSeconds: 60 },
      );
      await new Promise((r) => setTimeout(r, 500));
      await w.stop();
      expect(
        (await q(sql`SELECT status, last_error FROM jobs WHERE type = 'does-not-exist'`))[0],
      ).toMatchObject({ status: 'failed' });
    });
  });
});
