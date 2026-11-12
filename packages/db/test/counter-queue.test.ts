import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { allocateTicketNumber, formatTicketNumber, tickets } from '../src';
import { createTestDb, type TestDb } from '../src/testing';
import { makeTicket, makeUser } from './helpers';

describe('ticket numbers', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.drop());

  const create = async (customerId: string, failAfterAllocate = false) =>
    t.db.transaction(async (tx) => {
      const number = await allocateTicketNumber(tx);
      if (failAfterAllocate) throw new Error('boom');
      const now = new Date();
      await tx.insert(tickets).values({
        number,
        subject: `s${number}`,
        category: 'other',
        customerId,
        firstResponseDue: now,
        resolutionDue: now,
      });
      return number;
    });

  it('50 concurrent creations: unique, gap-free, starting at HD-1001', async () => {
    const c = await makeUser(t.db);
    const numbers = await Promise.all(Array.from({ length: 50 }, () => create(c.id)));
    expect(new Set(numbers).size).toBe(50);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => 1001 + i),
    );
    expect(formatTicketNumber(1042)).toBe('HD-1042');
  });

  it('a failed (rolled-back) creation does not burn a number — no gaps', async () => {
    const c = await makeUser(t.db);
    const before = (await t.db.execute<{ value: string }>(sql`SELECT value FROM counters`)).rows[0]
      ?.value;
    const results = await Promise.allSettled([
      create(c.id),
      create(c.id, true),
      create(c.id, true),
      create(c.id),
      create(c.id, true),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3);
    const ok = results
      .flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      .sort((a, b) => a - b);
    expect(ok).toEqual([Number(before) + 1, Number(before) + 2]);
    const all = (
      await t.db.execute<{ number: number }>(
        sql`SELECT number FROM tickets WHERE number > 1000 ORDER BY number`,
      )
    ).rows.map((r) => r.number);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => 1001 + i));
  });

  it('100 mixed concurrent creations (30% failing) stay gap-free', async () => {
    const c = await makeUser(t.db);
    await Promise.allSettled(Array.from({ length: 100 }, (_, i) => create(c.id, i % 3 === 0)));
    const all = (
      await t.db.execute<{ number: number }>(
        sql`SELECT number FROM tickets WHERE number > 1000 ORDER BY number`,
      )
    ).rows.map((r) => r.number);
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => 1001 + i));
  });

  it('missing counter row is a loud error, not a silent NaN/duplicate', async () => {
    const fresh = await createTestDb();
    try {
      await fresh.db.execute(sql`DELETE FROM counters`);
      await expect(fresh.db.transaction((tx) => allocateTicketNumber(tx))).rejects.toThrow(
        /counter/,
      );
    } finally {
      await fresh.drop();
    }
  });
});

describe('queue contract ("take next" relies on this index + SKIP LOCKED)', () => {
  let t: TestDb;
  let cust: string;
  beforeAll(async () => {
    t = await createTestDb();
    cust = (await makeUser(t.db)).id;
  });
  afterAll(async () => t.drop());

  const claim = (agentId: string, categories: string[], holdMs = 50) =>
    t.db.transaction(async (tx) => {
      if (categories.length === 0) return null;
      const list = sql.join(
        categories.map((c) => sql`${c}`),
        sql`, `,
      );
      const r = await tx.execute<{ id: string; number: number }>(sql`
        SELECT id, number FROM tickets
        WHERE assignee_id IS NULL AND status IN ('new','open') AND category IN (${list})
        ORDER BY priority DESC, sla_due_at ASC, created_at ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = r.rows[0];
      if (!row) return null;
      await new Promise((res) => setTimeout(res, holdMs));
      await tx.execute(
        sql`UPDATE tickets SET assignee_id = ${agentId}, version = version + 1 WHERE id = ${row.id}`,
      );
      return row.number;
    });

  it('6 agents claiming at once get 6 different tickets, and they are the 6 most urgent', async () => {
    const agents = await Promise.all(Array.from({ length: 6 }, () => makeUser(t.db, 'agent')));
    const base = Date.now();
    const mk = (
      priority: 'low' | 'normal' | 'high' | 'urgent',
      dueMin: number,
      category = 'payment',
    ) =>
      makeTicket(t.db, cust, {
        category,
        priority,
        status: 'new',
        firstResponseDue: new Date(base + dueMin * 60_000),
        resolutionDue: new Date(base + dueMin * 60_000 + 1000),
      });
    const urgent = [await mk('urgent', 30), await mk('urgent', 10)];
    const high = [await mk('high', 5), await mk('high', 50), await mk('high', 20)];
    await Promise.all([mk('low', 1), mk('normal', 1), mk('normal', 2), mk('low', 3, 'delivery')]);
    const got = await Promise.all(agents.map((a) => claim(a.id, ['payment'])));
    expect(got.every((n) => n !== null)).toBe(true);
    expect(new Set(got).size).toBe(6);
    const expected = new Set([...urgent, ...high].map((x) => x.number));
    // 2 urgent + 3 high + the 1 most urgent "normal"/"low" must be taken; urgent+high all gone:
    for (const n of expected) expect(got).toContain(n);
  });

  it('more claimers than tickets: extra agents get nothing, nobody gets a duplicate', async () => {
    const agents = await Promise.all(Array.from({ length: 10 }, () => makeUser(t.db, 'agent')));
    const base = Date.now();
    for (let i = 0; i < 4; i += 1)
      await makeTicket(t.db, cust, {
        category: 'technical',
        status: 'open',
        firstResponseDue: new Date(base + i * 1000),
        resolutionDue: new Date(base + 1e6),
      });
    const got = await Promise.all(agents.map((a) => claim(a.id, ['technical'])));
    const taken = got.filter((n): n is number => n !== null);
    expect(taken).toHaveLength(4);
    expect(new Set(taken).size).toBe(4);
  });

  it('an agent never receives a ticket outside their categories, assigned tickets, or tickets not new/open', async () => {
    const a = await makeUser(t.db, 'agent');
    const other = await makeUser(t.db, 'agent');
    await t.db.execute(
      sql`UPDATE tickets SET status = 'closed', resolved_at = now(), closed_at = now() WHERE assignee_id IS NULL`,
    ); // clear earlier tests' leftovers
    await makeTicket(t.db, cust, { category: 'account', status: 'new' });
    await makeTicket(t.db, cust, {
      category: 'delivery',
      status: 'pending',
      slaPausedAt: new Date(),
    });
    await makeTicket(t.db, cust, { category: 'delivery', status: 'new', assigneeId: other.id });
    await makeTicket(t.db, cust, {
      category: 'delivery',
      status: 'closed',
      resolvedAt: new Date(),
      closedAt: new Date(),
    });
    expect(await claim(a.id, ['delivery'])).toBeNull();
    expect(await claim(a.id, [])).toBeNull();
  });

  it('claimed ticket version is bumped exactly once and only one assignee ends up on it', async () => {
    const a = await Promise.all([makeUser(t.db, 'agent'), makeUser(t.db, 'agent')]);
    const tk = await makeTicket(t.db, cust, { category: 'other', status: 'new' });
    await Promise.all(a.map((x) => claim(x.id, ['other'])));
    const [row] = await t.db
      .select()
      .from(tickets)
      .where(sql`id = ${tk.id}`);
    expect(row?.version).toBe(2);
    expect(a.map((x) => x.id)).toContain(row?.assigneeId);
  });
});
