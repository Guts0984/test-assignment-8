import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  as,
  createExtraAgents,
  createTicketAs,
  createUsers,
  newTicketBody,
  reply,
  signIn,
  startApi,
  type Api,
  type Session,
  type TestUsers,
  type TicketJson,
} from './harness';

describe('concurrency: races must never corrupt, duplicate or silently overwrite', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let customer: Session, agent: Session, agent2: Session, lead: Session;
  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '1000000',
      RATE_LIMIT_USER_PER_MIN: '1000000',
      LOGIN_IP_MAX_FAILURES: '10000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
      DB_POOL_MAX: '20',
    });
    [customer, agent, agent2, lead] = await Promise.all([
      signIn(api, u.customer.email, PASSWORDS.customer),
      signIn(api, u.agent.email, PASSWORDS.agent),
      signIn(api, u.agent2.email, PASSWORDS.agent),
      signIn(api, u.lead.email, PASSWORDS.lead),
    ]);
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });
  const count = async (query: ReturnType<typeof sql>) =>
    Number(Object.values((await t.db.execute(query)).rows[0] ?? {})[0]);

  describe('versions (optimistic locking)', () => {
    it('two staff members change the same ticket at once: exactly one wins, the other gets 409 with the CURRENT state', async () => {
      const tk = await createTicketAs(api, customer);
      const [a, b] = await Promise.all([
        as(api, lead).patch(`/tickets/${tk.id}`, { version: 1, priority: 'high' }),
        as(api, agent).patch(`/tickets/${tk.id}`, { version: 1, priority: 'low' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 200 ? a : b;
      const err = (loser.json as { error: { code: string; current: TicketJson } }).error;
      expect(err.code).toBe('version_conflict');
      expect(err.current.version).toBe(2);
      expect(err.current.priority).toBe((winner.json as TicketJson).priority); // the current state is what the winner wrote
      const db = (
        await t.db.execute<{ priority: string; version: number }>(
          sql`SELECT priority, version FROM tickets WHERE id = ${tk.id}`,
        )
      ).rows[0]!;
      expect(db).toMatchObject({ priority: (winner.json as TicketJson).priority, version: 2 });
    });

    it('a stale version never overwrites, even for a different field; retrying with the current version works', async () => {
      const tk = await createTicketAs(api, customer);
      expect(
        (await as(api, lead).patch(`/tickets/${tk.id}`, { version: 1, tags: ['a'] })).status,
      ).toBe(200);
      const stale = await as(api, agent).patch(`/tickets/${tk.id}`, { version: 1, status: 'open' });
      expect(stale.status).toBe(409);
      expect((await as(api, lead).get(`/tickets/${tk.id}`)).json).toMatchObject({
        ticket: { status: 'new', tags: ['a'], version: 2 },
      });
      expect(
        (await as(api, agent).patch(`/tickets/${tk.id}`, { version: 2, status: 'open' })).status,
      ).toBe(200);
    });

    it('future / wrong versions are conflicts too, not silent successes', async () => {
      const tk = await createTicketAs(api, customer);
      for (const version of [2, 99, 1_000_000])
        expect(
          (await as(api, lead).patch(`/tickets/${tk.id}`, { version, priority: 'high' })).status,
          String(version),
        ).toBe(409);
    });

    it('20 simultaneous patches with the same version: exactly one succeeds, the DB version moved by exactly 1', async () => {
      const tk = await createTicketAs(api, customer);
      const rs = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          as(api, lead).patch(`/tickets/${tk.id}`, { version: 1, tags: [`t${i}`] }),
        ),
      );
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(19);
      expect(await count(sql`SELECT version FROM tickets WHERE id = ${tk.id}`)).toBe(2);
      expect(
        await count(
          sql`SELECT count(*) FROM ticket_events WHERE ticket_id = ${tk.id} AND field = 'tags'`,
        ),
      ).toBe(1);
    });
  });

  describe('idempotent replies (double click, network retry)', () => {
    it('25 parallel sends of the SAME message id create exactly one message; every caller gets that message back', async () => {
      const tk = await createTicketAs(api, customer);
      const body = reply('click click click');
      const rs = await Promise.all(
        Array.from({ length: 25 }, () =>
          as(api, customer).post(`/tickets/${tk.id}/messages`, body),
        ),
      );
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 200)).toHaveLength(24);
      const ids = new Set(rs.map((r) => (r.json as { message: { id: string } }).message.id));
      expect(ids.size).toBe(1);
      expect(rs.filter((r) => (r.json as { replayed: boolean }).replayed)).toHaveLength(24);
      expect(
        await count(
          sql`SELECT count(*) FROM messages WHERE ticket_id = ${tk.id} AND body = 'click click click'`,
        ),
      ).toBe(1);
    });

    it('a retry after the first response was lost returns the original message (replayed), unchanged', async () => {
      const tk = await createTicketAs(api, customer);
      const body = reply('did that arrive?');
      const first = await as(api, customer).post(`/tickets/${tk.id}/messages`, body);
      const again = await as(api, customer).post(`/tickets/${tk.id}/messages`, body);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect((again.json as { message: { id: string } }).message.id).toBe(
        (first.json as { message: { id: string } }).message.id,
      );
    });

    it('the same id with DIFFERENT content, or on another ticket, is a conflict (never silently "replayed")', async () => {
      const a = await createTicketAs(api, customer);
      const b = await createTicketAs(api, customer);
      const body = reply('original');
      await as(api, customer).post(`/tickets/${a.id}/messages`, body);
      expect(
        (await as(api, customer).post(`/tickets/${a.id}/messages`, { ...body, body: 'edited' }))
          .status,
      ).toBe(409);
      expect((await as(api, customer).post(`/tickets/${b.id}/messages`, body)).status).toBe(409);
    });

    it('a status-changing reply replayed 10 times changes the status once and writes one history row', async () => {
      const tk = await createTicketAs(api, customer);
      const body = reply('please send logs', { setStatus: 'pending' });
      await Promise.all(
        Array.from({ length: 10 }, () => as(api, agent).post(`/tickets/${tk.id}/messages`, body)),
      );
      // one net transition (new → pending), applied once
      expect(
        await count(
          sql`SELECT count(*) FROM ticket_events WHERE ticket_id = ${tk.id} AND field = 'status'`,
        ),
      ).toBe(1);
      expect(await count(sql`SELECT version FROM tickets WHERE id = ${tk.id}`)).toBe(2);
      expect(
        await count(
          sql`SELECT count(*) FROM messages WHERE ticket_id = ${tk.id} AND body = 'please send logs'`,
        ),
      ).toBe(1);
    });

    it("a different user may use the same client id (ids are per author — nobody can block or probe another user's ids)", async () => {
      const tk = await createTicketAs(api, customer);
      const id = crypto.randomUUID();
      expect(
        (await as(api, customer).post(`/tickets/${tk.id}/messages`, { id, body: 'mine' })).status,
      ).toBe(201);
      expect(
        (await as(api, agent).post(`/tickets/${tk.id}/messages`, { id, body: 'theirs' })).status,
      ).toBe(201);
    });

    it('creating a ticket is idempotent too: 15 parallel creates with one clientMessageId → one ticket, one number', async () => {
      const body = newTicketBody({ subject: 'double submit' });
      const before = await count(sql`SELECT value FROM counters`);
      const rs = await Promise.all(
        Array.from({ length: 15 }, () => as(api, customer).post('/tickets', body)),
      );
      expect(rs.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(new Set(rs.map((r) => (r.json as TicketJson).id)).size).toBe(1);
      expect(await count(sql`SELECT count(*) FROM tickets WHERE subject = 'double submit'`)).toBe(
        1,
      );
      expect(await count(sql`SELECT value FROM counters`)).toBe(before + 1); // no number burned by the losers
    });
  });

  describe('ticket numbers', () => {
    it('50 simultaneous creations (acceptance #9): 50 distinct numbers, no gaps, no repeats', async () => {
      const first = await count(sql`SELECT COALESCE(max(number), 1000) FROM tickets`);
      const rs = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          as(api, i % 2 ? customer : customer).post(
            '/tickets',
            newTicketBody({ subject: `burst ${i}` }),
          ),
        ),
      );
      expect(rs.every((r) => r.status === 201)).toBe(true);
      const numbers = rs.map((r) => (r.json as TicketJson).number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => first + 1 + i));
      expect(await count(sql`SELECT count(*) - count(DISTINCT number) FROM tickets`)).toBe(0);
    });

    it('failed creations (validation errors, bad attachments) in the middle of a burst burn no numbers', async () => {
      const first = await count(sql`SELECT max(number) FROM tickets`);
      const rs = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          as(api, customer).post(
            '/tickets',
            i % 3 === 0
              ? newTicketBody({ attachmentIds: [crypto.randomUUID()] })
              : i % 3 === 1
                ? { subject: '' }
                : newTicketBody({ subject: `ok ${i}` }),
          ),
        ),
      );
      const ok = rs
        .filter((r) => r.status === 201)
        .map((r) => (r.json as TicketJson).number)
        .sort((a, b) => a - b);
      expect(ok).toHaveLength(10);
      expect(ok).toEqual(Array.from({ length: 10 }, (_, i) => first + 1 + i));
    });
  });

  describe('"take next"', () => {
    it('6 agents press the button at the same moment → 6 DIFFERENT tickets, the 6 most urgent ones (acceptance #6)', async () => {
      const extra = await createExtraAgents(t.db, 6, ['technical']);
      const sessions = await Promise.all(extra.map((a) => signIn(api, a.email, PASSWORDS.agent)));
      // 10 free tickets with distinct urgency
      const made: TicketJson[] = [];
      for (const [priority, n] of [
        ['low', 2],
        ['normal', 3],
        ['high', 3],
        ['urgent', 2],
      ] as const) {
        for (let i = 0; i < n; i += 1)
          made.push(
            await createTicketAs(api, customer, {
              category: 'technical',
              priority: priority === 'urgent' ? 'high' : priority,
              subject: `q-${priority}-${i}`,
            }),
          );
      }
      const urgent = made.filter((m) => m.subject.startsWith('q-urgent'));
      for (const m of urgent)
        await as(api, lead).patch(`/tickets/${m.id}`, { version: 1, priority: 'urgent' });

      const rs = await Promise.all(sessions.map((s) => as(api, s).post('/tickets/take-next')));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      const got = rs.map((r) => r.json as TicketJson);
      expect(new Set(got.map((g) => g.id)).size).toBe(6);
      expect(got.every((g, i) => g.assignee?.id === extra[i]!.id)).toBe(true);
      // the 2 urgent + 3 high + 1 best normal were handed out
      const rank = { urgent: 3, high: 2, normal: 1, low: 0 } as const;
      const handed = got.map((g) => rank[g.priority as keyof typeof rank]).sort((a, b) => b - a);
      expect(handed).toEqual([3, 3, 2, 2, 2, 1]);
      expect(
        await count(
          sql`SELECT count(*) FROM tickets WHERE category = 'technical' AND assignee_id IS NOT NULL`,
        ),
      ).toBe(6);
    });

    it('30 simultaneous takers for 8 free tickets: exactly 8 succeed, 22 get a clean 404, nobody gets a duplicate', async () => {
      await t.db.execute(
        sql`UPDATE tickets SET status = 'closed', resolved_at = now(), closed_at = now() WHERE assignee_id IS NULL AND status IN ('new','open')`,
      );
      for (let i = 0; i < 8; i += 1)
        await createTicketAs(api, customer, { category: 'account', subject: `acc-${i}` });
      const rs = await Promise.all(
        Array.from({ length: 30 }, () => as(api, lead).post('/tickets/take-next')),
      );
      const ok = rs.filter((r) => r.status === 200);
      expect(ok).toHaveLength(8);
      expect(new Set(ok.map((r) => (r.json as TicketJson).id)).size).toBe(8);
      const none = rs.filter((r) => r.status === 404);
      expect(none).toHaveLength(22);
      expect(
        none.every((r) => (r.json as { error: { code: string } }).error.code === 'not_found'),
      ).toBe(true);
      expect(
        await count(
          sql`SELECT count(*) FROM tickets WHERE category = 'account' AND assignee_id = ${u.lead.id}`,
        ),
      ).toBe(8);
    });

    it('does not WAIT for a ticket someone else is holding: a locked top ticket is skipped, the next one is served at once (SKIP LOCKED)', async () => {
      await t.db.execute(
        sql`UPDATE tickets SET status = 'closed', resolved_at = now(), closed_at = now() WHERE assignee_id IS NULL AND status IN ('new','open')`,
      );
      const top = await createTicketAs(api, customer, {
        category: 'other',
        priority: 'high',
        subject: 'locked top',
      });
      const next = await createTicketAs(api, customer, {
        category: 'other',
        priority: 'low',
        subject: 'next in line',
      });
      const [taker] = await createExtraAgents(t.db, 1, ['other']);
      const s = await signIn(api, taker!.email, PASSWORDS.agent);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const locked = new Promise<void>((resolveLocked) => {
        void t.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM tickets WHERE id = ${top.id} FOR UPDATE`);
          resolveLocked();
          await held; // keep the row lock while the API call below runs
        });
      });
      await locked;
      const started = Date.now();
      const r = await as(api, s).post('/tickets/take-next');
      const waited = Date.now() - started;
      release();
      expect(r.status).toBe(200);
      expect((r.json as TicketJson).id).toBe(next.id);
      expect(waited, 'take-next must not block on a row another transaction holds').toBeLessThan(
        1500,
      );
    });

    it('an agent only ever receives tickets of their own categories; with nothing available the answer is a clean 404', async () => {
      await t.db.execute(
        sql`UPDATE tickets SET status = 'closed', resolved_at = now(), closed_at = now() WHERE assignee_id IS NULL AND status IN ('new','open')`,
      );
      const mine = await createTicketAs(api, customer, {
        category: 'payment',
        subject: 'for agent one',
      });
      await createTicketAs(api, customer, { category: 'delivery', subject: 'not for agent one' });
      const r = await as(api, agent).post('/tickets/take-next');
      expect(r.status).toBe(200);
      expect((r.json as TicketJson).id).toBe(mine.id);
      const none = await as(api, agent).post('/tickets/take-next');
      expect(none.status).toBe(404);
      expect(none.json).toMatchObject({ error: { code: 'not_found' } });
      expect((await as(api, agent2).post('/tickets/take-next')).status).toBe(200);
    });

    it('does not take tickets that are assigned, pending, resolved or closed; urgent first, then the earliest SLA deadline', async () => {
      await t.db.execute(
        sql`UPDATE tickets SET status = 'closed', resolved_at = now(), closed_at = now() WHERE assignee_id IS NULL AND status IN ('new','open')`,
      );
      const a = await createTicketAs(api, customer, {
        category: 'other',
        priority: 'low',
        subject: 'low',
      });
      const b = await createTicketAs(api, customer, {
        category: 'other',
        priority: 'high',
        subject: 'high',
      });
      const c = await createTicketAs(api, customer, {
        category: 'other',
        priority: 'high',
        subject: 'high but pending',
      });
      await t.db.execute(
        sql`UPDATE tickets SET status = 'pending', sla_paused_at = now() WHERE id = ${c.id}`,
      );
      const [leadA] = await createExtraAgents(t.db, 1, ['other']);
      const s = await signIn(api, leadA!.email, PASSWORDS.agent);
      expect(((await as(api, s).post('/tickets/take-next')).json as TicketJson).id).toBe(b.id);
      expect(((await as(api, s).post('/tickets/take-next')).json as TicketJson).id).toBe(a.id);
      expect((await as(api, s).post('/tickets/take-next')).status).toBe(404);
    });
  });
});
