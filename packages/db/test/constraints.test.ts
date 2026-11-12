import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  agentCategories,
  attachments,
  cannedResponses,
  jobs,
  messages,
  notifications,
  ratings,
  rateLimits,
  slaPolicies,
  tickets,
  users,
  sessions,
  ticketEvents,
} from '../src';
import { createTestDb, type TestDb } from '../src/testing';
import { SQLSTATE as S, makeTicket, makeUser, pgCode } from './helpers';

describe('database constraints reject bad data (every rule enforced by PostgreSQL itself)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.drop());

  const customer = () => makeUser(t.db, 'customer');
  const subj = async (subject: string) => {
    const c = await customer();
    return pgCode(makeTicket(t.db, c.id, { subject }));
  };

  describe('users', () => {
    it('email must be lowercase and unique', async () => {
      expect(await pgCode(makeUser(t.db, 'customer', { email: 'Upper@Case.test' }))).toBe(S.check);
      await makeUser(t.db, 'customer', { email: 'dup@x.test' });
      expect(await pgCode(makeUser(t.db, 'customer', { email: 'dup@x.test' }))).toBe(S.unique);
    });
    it('rejects blank name and unknown role', async () => {
      expect(await pgCode(makeUser(t.db, 'customer', { name: '   ' }))).toBe(S.check);
      expect(
        await pgCode(
          t.db.execute(
            sql`INSERT INTO users(email,name,role,password_hash) VALUES ('r@x.test','n','admin','x')`,
          ),
        ),
      ).toBe(S.badEnum);
    });
  });

  describe('tickets', () => {
    it('subject: 1..200 after trim, whitespace-only rejected', async () => {
      expect(await subj('')).toBe(S.check);
      expect(await subj('   ')).toBe(S.check);
      expect(await subj('\t\n')).toBe(S.check);
      expect(await subj('a'.repeat(201))).toBe('22001'); // varchar(200) overflow
      expect(await subj('a')).toBe(S.ok);
      expect(await subj('я'.repeat(200))).toBe(S.ok);
    });
    it('invalid enum values and unknown category are rejected', async () => {
      const c = await customer();
      for (const [col, val] of [
        ['status', 'reopened'],
        ['priority', 'critical'],
      ] as const)
        expect(
          await pgCode(
            t.db
              .execute(sql`UPDATE tickets SET ${sql.raw(col)} = ${val} WHERE false`)
              .then(() =>
                t.db.execute(
                  sql`SELECT ${val}::${sql.raw(col === 'status' ? 'ticket_status' : 'priority')}`,
                ),
              ),
          ),
        ).toBe(S.badEnum);
      expect(await pgCode(makeTicket(t.db, c.id, { category: 'billing' }))).toBe(S.fk);
    });
    it('ticket number is unique and positive', async () => {
      const c = await customer();
      await makeTicket(t.db, c.id, { number: 555_555 });
      expect(await pgCode(makeTicket(t.db, c.id, { number: 555_555 }))).toBe(S.unique);
      expect(await pgCode(makeTicket(t.db, c.id, { number: 0 }))).toBe(S.check);
      expect(await pgCode(makeTicket(t.db, c.id, { number: -3 }))).toBe(S.check);
    });
    it('version must be >= 1', async () => {
      const c = await customer();
      expect(await pgCode(makeTicket(t.db, c.id, { version: 0 }))).toBe(S.check);
    });
    it('tags: no NULL elements, at most 20, column itself never NULL', async () => {
      const c = await customer();
      expect(
        await pgCode(
          t.db.execute(
            sql`INSERT INTO tickets(number,subject,category,customer_id,first_response_due,resolution_due,tags) VALUES (900001,'s','other',${c.id},now(),now(),ARRAY['a',NULL])`,
          ),
        ),
      ).toBe(S.check);
      expect(
        await pgCode(
          makeTicket(t.db, c.id, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
        ),
      ).toBe(S.check);
      expect(
        await pgCode(
          makeTicket(t.db, c.id, { tags: Array.from({ length: 20 }, (_, i) => `t${i}`) }),
        ),
      ).toBe(S.ok);
      expect(
        await pgCode(
          t.db.execute(
            sql`INSERT INTO tickets(number,subject,category,customer_id,first_response_due,resolution_due,tags) VALUES (900002,'s','other',${c.id},now(),now(),NULL)`,
          ),
        ),
      ).toBe(S.notNull);
    });
    it('customer and assignee must exist; a ticket cannot link to itself', async () => {
      const c = await customer();
      expect(await pgCode(makeTicket(t.db, '00000000-0000-4000-8000-000000000000'))).toBe(S.fk);
      expect(
        await pgCode(
          makeTicket(t.db, c.id, { assigneeId: '00000000-0000-4000-8000-000000000000' }),
        ),
      ).toBe(S.fk);
      const tk = await makeTicket(t.db, c.id);
      expect(
        await pgCode(
          t.db
            .update(tickets)
            .set({ linkedTicketId: tk.id })
            .where(sql`id = ${tk.id}`),
        ),
      ).toBe(S.check);
    });
    it('resolution deadline cannot precede first-response deadline', async () => {
      const c = await customer();
      const now = Date.now();
      expect(
        await pgCode(
          makeTicket(t.db, c.id, {
            firstResponseDue: new Date(now + 5000),
            resolutionDue: new Date(now),
          }),
        ),
      ).toBe(S.check);
    });
    it('resolved/closed need their timestamps; paused-minutes only while paused', async () => {
      const c = await customer();
      expect(await pgCode(makeTicket(t.db, c.id, { status: 'resolved' }))).toBe(S.check);
      expect(
        await pgCode(makeTicket(t.db, c.id, { status: 'closed', resolvedAt: new Date() })),
      ).toBe(S.check);
      expect(
        await pgCode(makeTicket(t.db, c.id, { status: 'open', firstResponseRemainingMin: 30 })),
      ).toBe(S.check);
      expect(
        await pgCode(
          makeTicket(t.db, c.id, {
            status: 'pending',
            slaPausedAt: new Date(),
            firstResponseRemainingMin: -1,
          }),
        ),
      ).toBe(S.check);
      expect(
        await pgCode(
          makeTicket(t.db, c.id, {
            status: 'pending',
            slaPausedAt: new Date(),
            firstResponseRemainingMin: 30,
            resolutionRemainingMin: 90,
          }),
        ),
      ).toBe(S.ok);
    });
    it('generated columns cannot be written (sla_due_at, search)', async () => {
      const c = await customer();
      const tk = await makeTicket(t.db, c.id);
      expect(
        await pgCode(t.db.execute(sql`UPDATE tickets SET sla_due_at = now() WHERE id = ${tk.id}`)),
      ).toBe(S.generatedWrite);
      expect(
        await pgCode(
          t.db.execute(sql`UPDATE tickets SET search = ''::tsvector WHERE id = ${tk.id}`),
        ),
      ).toBe(S.generatedWrite);
    });
    it('sla_due_at follows the status: first deadline → resolution deadline → NULL when paused/resolved/closed', async () => {
      const c = await customer();
      const created = new Date();
      const tk = await makeTicket(t.db, c.id, { status: 'new' });
      const read = async () =>
        (
          await t.db.execute<{ d: string | null }>(
            sql`SELECT sla_due_at AS d FROM tickets WHERE id = ${tk.id}`,
          )
        ).rows[0]?.d ?? null;
      expect(new Date(String(await read())).getTime()).toBe(tk.firstResponseDue.getTime());
      await t.db.execute(
        sql`UPDATE tickets SET first_responded_at = now(), status = 'open' WHERE id = ${tk.id}`,
      );
      expect(new Date(String(await read())).getTime()).toBe(tk.resolutionDue.getTime());
      await t.db.execute(
        sql`UPDATE tickets SET status = 'pending', sla_paused_at = now() WHERE id = ${tk.id}`,
      );
      expect(await read()).toBeNull();
      await t.db.execute(
        sql`UPDATE tickets SET status = 'resolved', resolved_at = now(), sla_paused_at = NULL WHERE id = ${tk.id}`,
      );
      expect(await read()).toBeNull();
      expect(created).toBeInstanceOf(Date);
    });
    it('deleting a customer who owns tickets is refused (no orphan tickets)', async () => {
      const c = await customer();
      await makeTicket(t.db, c.id);
      expect(await pgCode(t.db.delete(users).where(sql`id = ${c.id}`))).toBe(S.fk);
    });
    it('deleting the assignee un-assigns instead of deleting tickets', async () => {
      const c = await customer();
      const a = await makeUser(t.db, 'agent');
      const tk = await makeTicket(t.db, c.id, { assigneeId: a.id });
      await t.db.delete(users).where(sql`id = ${a.id}`);
      const [row] = await t.db
        .select()
        .from(tickets)
        .where(sql`id = ${tk.id}`);
      expect(row?.assigneeId).toBeNull();
    });
  });

  describe('messages', () => {
    const msg = (
      ticketId: string,
      authorId: string,
      over: Partial<typeof messages.$inferInsert> = {},
    ) =>
      t.db
        .insert(messages)
        .values({ ticketId, authorId, clientId: crypto.randomUUID(), body: 'hello', ...over });
    it('body 1..20000 non-blank', async () => {
      const c = await customer();
      const tk = await makeTicket(t.db, c.id);
      expect(await pgCode(msg(tk.id, c.id, { body: '' }))).toBe(S.check);
      expect(await pgCode(msg(tk.id, c.id, { body: '  \n ' }))).toBe(S.check);
      expect(await pgCode(msg(tk.id, c.id, { body: 'x'.repeat(20_001) }))).toBe(S.check);
      expect(await pgCode(msg(tk.id, c.id, { body: 'x'.repeat(20_000) }))).toBe(S.ok);
    });
    it('same author + same client id twice → unique violation (idempotency backstop); other author may reuse the id', async () => {
      const c = await customer();
      const a = await makeUser(t.db, 'agent');
      const tk = await makeTicket(t.db, c.id);
      const clientId = crypto.randomUUID();
      await msg(tk.id, c.id, { clientId });
      expect(await pgCode(msg(tk.id, c.id, { clientId }))).toBe(S.unique);
      expect(await pgCode(msg(tk.id, a.id, { clientId }))).toBe(S.ok);
    });
    it('N parallel inserts of one client id produce exactly one row', async () => {
      const c = await customer();
      const tk = await makeTicket(t.db, c.id);
      const clientId = crypto.randomUUID();
      const res = await Promise.all(
        Array.from({ length: 20 }, () =>
          t.db
            .insert(messages)
            .values({ ticketId: tk.id, authorId: c.id, clientId, body: 'dbl click' })
            .onConflictDoNothing()
            .returning({ id: messages.id }),
        ),
      );
      expect(res.filter((r) => r.length === 1)).toHaveLength(1);
      const n = (
        await t.db.execute<{ n: number }>(
          sql`SELECT count(*)::int n FROM messages WHERE client_id = ${clientId}`,
        )
      ).rows[0]?.n;
      expect(n).toBe(1);
    });
    it('kind is an enum; deleting a ticket cascades to messages, attachments rows and history', async () => {
      const c = await customer();
      const tk = await makeTicket(t.db, c.id);
      expect(
        await pgCode(
          t.db.execute(
            sql`INSERT INTO messages(ticket_id,author_id,client_id,kind,body) VALUES (${tk.id},${c.id},${crypto.randomUUID()},'system','x')`,
          ),
        ),
      ).toBe(S.badEnum);
      const [m] = await msg(tk.id, c.id).returning();
      await t.db.insert(attachments).values({
        uploaderId: c.id,
        messageId: m?.id ?? null,
        originalName: 'a.png',
        mime: 'image/png',
        sizeBytes: 10,
        storageKey: crypto.randomUUID(),
        sha256: 'x',
      });
      await t.db
        .insert(ticketEvents)
        .values({ ticketId: tk.id, field: 'status', oldValue: 'new', newValue: 'open' });
      await t.db.delete(tickets).where(sql`id = ${tk.id}`);
      for (const table of ['messages', 'attachments', 'ticket_events'])
        expect(
          (
            await t.db.execute<{ n: number }>(
              sql`SELECT count(*)::int n FROM ${sql.raw(table)} WHERE ${sql.raw(table === 'attachments' ? `message_id = '${m?.id}'` : `ticket_id = '${tk.id}'`)}`,
            )
          ).rows[0]?.n,
          table,
        ).toBe(0);
    });
  });

  describe('attachments', () => {
    const att = (uploaderId: string, over: Partial<typeof attachments.$inferInsert> = {}) =>
      t.db.insert(attachments).values({
        uploaderId,
        originalName: 'f',
        mime: 'image/png',
        sizeBytes: 100,
        storageKey: crypto.randomUUID(),
        sha256: 'h',
        ...over,
      });
    it('size 1 B … 10 MiB exactly', async () => {
      const c = await customer();
      expect(await pgCode(att(c.id, { sizeBytes: 0 }))).toBe(S.check);
      expect(await pgCode(att(c.id, { sizeBytes: -1 }))).toBe(S.check);
      expect(await pgCode(att(c.id, { sizeBytes: 10 * 1024 * 1024 + 1 }))).toBe(S.check);
      expect(await pgCode(att(c.id, { sizeBytes: 10 * 1024 * 1024 }))).toBe(S.ok);
      expect(await pgCode(att(c.id, { sizeBytes: 1 }))).toBe(S.ok);
    });
    it('only png/jpeg/gif/webp/pdf/text are storable — an exe can never be recorded', async () => {
      const c = await customer();
      for (const mime of [
        'application/x-msdownload',
        'application/octet-stream',
        'text/html',
        'image/svg+xml',
        '',
      ])
        expect(await pgCode(att(c.id, { mime })), mime).toBe(S.check);
      for (const mime of [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'application/pdf',
        'text/plain',
      ])
        expect(await pgCode(att(c.id, { mime })), mime).toBe(S.ok);
    });
    it('storage key is unique', async () => {
      const c = await customer();
      const storageKey = crypto.randomUUID();
      await att(c.id, { storageKey });
      expect(await pgCode(att(c.id, { storageKey }))).toBe(S.unique);
    });
  });

  describe('misc tables', () => {
    it('rating: 1..5, one per ticket', async () => {
      const c = await customer();
      const tk = await makeTicket(t.db, c.id);
      for (const score of [0, 6, -1])
        expect(
          await pgCode(t.db.insert(ratings).values({ ticketId: tk.id, customerId: c.id, score })),
        ).toBe(S.check);
      expect(
        await pgCode(t.db.insert(ratings).values({ ticketId: tk.id, customerId: c.id, score: 5 })),
      ).toBe(S.ok);
      expect(
        await pgCode(t.db.insert(ratings).values({ ticketId: tk.id, customerId: c.id, score: 4 })),
      ).toBe(S.unique);
    });
    it('sla policy: positive minutes, resolution >= first response, one per priority', async () => {
      expect(
        await pgCode(
          t.db
            .update(slaPolicies)
            .set({ firstResponseMinutes: 0 })
            .where(sql`priority = 'low'`),
        ),
      ).toBe(S.check);
      expect(
        await pgCode(
          t.db
            .update(slaPolicies)
            .set({ resolutionMinutes: 1 })
            .where(sql`priority = 'low'`),
        ),
      ).toBe(S.check);
      expect(
        await pgCode(
          t.db.insert(slaPolicies).values({
            priority: 'low',
            firstResponseMinutes: 1,
            resolutionMinutes: 2,
            businessHours: true,
          }),
        ),
      ).toBe(S.unique);
    });
    it('agent_categories: unknown category rejected, duplicate pair rejected', async () => {
      const a = await makeUser(t.db, 'agent');
      expect(
        await pgCode(t.db.insert(agentCategories).values({ userId: a.id, category: 'nope' })),
      ).toBe(S.fk);
      await t.db.insert(agentCategories).values({ userId: a.id, category: 'other' });
      expect(
        await pgCode(t.db.insert(agentCategories).values({ userId: a.id, category: 'other' })),
      ).toBe(S.unique);
    });
    it('canned response title not blank', async () => {
      expect(await pgCode(t.db.insert(cannedResponses).values({ title: ' ', body: 'b' }))).toBe(
        S.check,
      );
    });
    it('notification dedupe: same event cannot notify twice, but NULL dedupe key may repeat', async () => {
      const c = await customer();
      const a = await makeUser(t.db, 'agent');
      const tk = await makeTicket(t.db, c.id);
      const n = (dedupeKey: string | null) =>
        t.db
          .insert(notifications)
          .values({ userId: a.id, ticketId: tk.id, type: 'sla_warning', dedupeKey });
      await n('first_response');
      expect(await pgCode(n('first_response'))).toBe(S.unique);
      expect(await pgCode(n(null))).toBe(S.ok);
      expect(await pgCode(n(null))).toBe(S.ok);
    });
    it('rate_limits: counter cannot go negative; INSERT…ON CONFLICT increments atomically under 100 parallel hits', async () => {
      expect(
        await pgCode(
          t.db.insert(rateLimits).values({ key: 'neg', count: -1, windowStart: new Date() }),
        ),
      ).toBe(S.check);
      await Promise.all(
        Array.from({ length: 100 }, () =>
          t.db.execute(
            sql`INSERT INTO rate_limits(key,count,window_start) VALUES ('hot',1,now()) ON CONFLICT (key) DO UPDATE SET count = rate_limits.count + 1`,
          ),
        ),
      );
      const n = (
        await t.db.execute<{ count: number }>(sql`SELECT count FROM rate_limits WHERE key='hot'`)
      ).rows[0]?.count;
      expect(n).toBe(100);
    });
    it('sessions die with their user; session ids are unique', async () => {
      const c = await customer();
      await t.db
        .insert(sessions)
        .values({ id: 'h1', userId: c.id, expiresAt: new Date(Date.now() + 1000) });
      expect(
        await pgCode(
          t.db.insert(sessions).values({ id: 'h1', userId: c.id, expiresAt: new Date() }),
        ),
      ).toBe(S.unique);
      await t.db.delete(users).where(sql`id = ${c.id}`);
      expect(
        (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM sessions WHERE id='h1'`))
          .rows[0]?.n,
      ).toBe(0);
    });
  });

  describe('jobs table', () => {
    const job = (over: Partial<typeof jobs.$inferInsert> = {}) =>
      t.db.insert(jobs).values({ type: 'sla-scan', ...over });
    it('only one queued/running job per dedupe key — but a finished one does not block the next', async () => {
      await job({ dedupeKey: 'scan:1' });
      expect(await pgCode(job({ dedupeKey: 'scan:1' }))).toBe(S.unique);
      await t.db.execute(sql`UPDATE jobs SET status='done' WHERE dedupe_key='scan:1'`);
      expect(await pgCode(job({ dedupeKey: 'scan:1' }))).toBe(S.ok);
    });
    it('attempts cannot exceed max_attempts', async () => {
      expect(await pgCode(job({ attempts: 6, maxAttempts: 5 }))).toBe(S.check);
    });
    it('two workers racing for the same queued job: exactly one gets it (SKIP LOCKED)', async () => {
      await job({ dedupeKey: 'race:1', type: 'race' });
      const claim = () =>
        t.db.transaction(async (tx) => {
          const r = await tx.execute<{ id: number }>(
            sql`SELECT id FROM jobs WHERE type='race' AND status='queued' ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1`,
          );
          const id = r.rows[0]?.id;
          if (id === undefined) return null;
          await new Promise((res) => setTimeout(res, 100)); // hold the row lock while the other worker tries
          await tx.execute(sql`UPDATE jobs SET status='running' WHERE id=${id}`);
          return id;
        });
      const got = await Promise.all([claim(), claim(), claim()]);
      expect(got.filter((x) => x !== null)).toHaveLength(1);
    });
  });
});
