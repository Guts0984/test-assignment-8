import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '@node-rs/argon2';
import { sql, type SQL } from 'drizzle-orm';
import { CATEGORIES, DEFAULT_SLA_POLICIES, STATUSES, computeDeadlines } from '@helpdesk/shared';
import { createDb, seed, SEED_PASSWORDS, seedEmail, type SeedResult } from '../src';
import { generateDataset } from '../src/seed/generate';
import { createTestDb, type TestDb } from '../src/testing';

const NOW = new Date('2026-11-12T10:00:00Z');

describe('seed: 20 000 tickets on a real database', () => {
  let t: TestDb;
  let first: SeedResult;
  const q = async <T extends Record<string, unknown>>(query: SQL): Promise<T[]> =>
    (await t.db.execute(query)).rows as T[];
  const one = async (query: SQL): Promise<number> =>
    Number(Object.values((await q(query))[0] ?? {})[0]);

  beforeAll(async () => {
    t = await createTestDb();
    first = await seed(t, { now: NOW });
  });
  afterAll(async () => t.drop());

  describe('shape required by the assignment', () => {
    it('inserted 20 000 tickets, 200 customers, 6 agents, 1 lead', async () => {
      expect(first).toMatchObject({ skipped: false, tickets: 20_000 });
      expect(await one(sql`SELECT count(*) FROM tickets`)).toBe(20_000);
      expect(await one(sql`SELECT count(*) FROM users WHERE role='customer'`)).toBe(200);
      expect(await one(sql`SELECT count(*) FROM users WHERE role='agent'`)).toBe(6);
      expect(await one(sql`SELECT count(*) FROM users WHERE role='lead'`)).toBe(1);
    });
    it('covers half a year and every status', async () => {
      const r = (
        await q<{ lo: string; hi: string }>(
          sql`SELECT min(created_at) lo, max(created_at) hi FROM tickets`,
        )
      )[0];
      const days = (NOW.getTime() - new Date(String(r?.lo)).getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(175);
      expect(days).toBeLessThanOrEqual(180);
      expect(new Date(String(r?.hi)).getTime()).toBeLessThan(NOW.getTime());
      const statuses = await q<{ status: string; n: number }>(
        sql`SELECT status, count(*)::int n FROM tickets GROUP BY 1`,
      );
      expect(statuses.map((s) => s.status).sort()).toEqual([...STATUSES].sort());
      for (const s of statuses) expect(s.n, s.status).toBeGreaterThanOrEqual(50);
    });
    it('uses every priority and category; agents have different category sets covering all categories', async () => {
      expect(await one(sql`SELECT count(DISTINCT priority) FROM tickets`)).toBe(4);
      expect(await one(sql`SELECT count(DISTINCT category) FROM tickets`)).toBe(CATEGORIES.length);
      const sets = (
        await q<{ s: string }>(
          sql`SELECT string_agg(category, ',' ORDER BY category) s FROM agent_categories GROUP BY user_id`,
        )
      ).map((r) => r.s);
      expect(new Set(sets).size).toBe(6);
      expect(await one(sql`SELECT count(DISTINCT category) FROM agent_categories`)).toBe(
        CATEGORIES.length,
      );
    });
    it('ticket numbers are HD-1001…HD-21000: no gaps, no repeats; counter continues after them', async () => {
      expect(await one(sql`SELECT count(DISTINCT number) FROM tickets`)).toBe(20_000);
      expect(await one(sql`SELECT min(number) FROM tickets`)).toBe(1001);
      expect(await one(sql`SELECT max(number) FROM tickets`)).toBe(21_000);
      expect(await one(sql`SELECT value FROM counters WHERE name='ticket_number'`)).toBe(21_000);
    });
    it('numbers follow creation order', async () => {
      expect(
        await one(
          sql`SELECT count(*) FROM tickets a JOIN tickets b ON b.number = a.number + 1 WHERE b.created_at < a.created_at`,
        ),
      ).toBe(0);
    });
    it('credentials from the README really log in (argon2 hashes verify) and are role-specific', async () => {
      const get = async (email: string) =>
        String(
          (await q<{ h: string }>(sql`SELECT password_hash h FROM users WHERE email=${email}`))[0]
            ?.h,
        );
      expect(await verify(await get(seedEmail.lead()), SEED_PASSWORDS.lead)).toBe(true);
      expect(await verify(await get(seedEmail.agent(3)), SEED_PASSWORDS.agent)).toBe(true);
      expect(await verify(await get(seedEmail.customer(200)), SEED_PASSWORDS.customer)).toBe(true);
      expect(await verify(await get(seedEmail.agent(1)), SEED_PASSWORDS.customer)).toBe(false);
      expect(
        await one(sql`SELECT count(*) FROM users WHERE password_hash NOT LIKE '$argon2id$%'`),
      ).toBe(0);
    });
  });

  describe('internal consistency (each query counts violations and must return 0)', () => {
    const zero = (name: string, query: SQL) =>
      it(name, async () => expect(await one(query)).toBe(0));

    zero(
      'every ticket starts with a customer message at creation time',
      sql`SELECT count(*) FROM tickets t WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id=t.id AND m.author_id=t.customer_id AND m.created_at=t.created_at AND m.kind='public')`,
    );
    zero(
      'customers never authored an internal note',
      sql`SELECT count(*) FROM messages m JOIN users u ON u.id=m.author_id WHERE m.kind='internal' AND u.role='customer'`,
    );
    zero(
      'customers only wrote on their own tickets',
      sql`SELECT count(*) FROM messages m JOIN users u ON u.id=m.author_id JOIN tickets t ON t.id=m.ticket_id WHERE u.role='customer' AND t.customer_id<>u.id`,
    );
    zero(
      'no message is dated in the future or before its ticket',
      sql`SELECT count(*) FROM messages m JOIN tickets t ON t.id=m.ticket_id WHERE m.created_at > ${NOW.toISOString()}::timestamptz OR m.created_at < t.created_at`,
    );
    zero(
      'updated_at >= created_at and not in the future',
      sql`SELECT count(*) FROM tickets WHERE updated_at < created_at OR updated_at > ${NOW.toISOString()}::timestamptz`,
    );
    zero(
      'status "new" tickets have no agent reply; every other status has a first response',
      sql`SELECT count(*) FROM tickets WHERE (status='new' AND first_responded_at IS NOT NULL) OR (status<>'new' AND first_responded_at IS NULL)`,
    );
    zero(
      'first_responded_at equals the first public staff message',
      sql`SELECT count(*) FROM tickets t WHERE first_responded_at IS NOT NULL AND first_responded_at <> (SELECT min(m.created_at) FROM messages m JOIN users u ON u.id=m.author_id WHERE m.ticket_id=t.id AND m.kind='public' AND u.role<>'customer')`,
    );
    zero(
      'resolved/closed times are ordered and closed = resolved + exactly 3 days',
      sql`SELECT count(*) FROM tickets WHERE (resolved_at IS NOT NULL AND resolved_at < first_responded_at) OR (status='closed' AND closed_at <> resolved_at + interval '3 days') OR (closed_at > ${NOW.toISOString()}::timestamptz)`,
    );
    zero(
      'no ticket is "resolved" for longer than 3 days (the auto-close job would have closed it)',
      sql`SELECT count(*) FROM tickets WHERE status='resolved' AND resolved_at < ${NOW.toISOString()}::timestamptz - interval '3 days'`,
    );
    zero(
      'assignees are agents; "new" tickets are (almost) unassigned',
      sql`SELECT count(*) FROM tickets t JOIN users u ON u.id=t.assignee_id WHERE u.role<>'agent'`,
    );
    zero(
      'last public message of a pending ticket is from staff (we are waiting for the customer)',
      sql`SELECT count(*) FROM tickets t WHERE status='pending' AND (SELECT u.role FROM messages m JOIN users u ON u.id=m.author_id WHERE m.ticket_id=t.id AND m.kind='public' ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = 'customer'`,
    );
    zero(
      'paused tickets are exactly the pending ones',
      sql`SELECT count(*) FROM tickets WHERE (status='pending') <> (sla_paused_at IS NOT NULL)`,
    );
    zero(
      'breach marks never lie in the future',
      sql`SELECT count(*) FROM tickets WHERE first_response_breached_at > ${NOW.toISOString()}::timestamptz OR resolution_breached_at > ${NOW.toISOString()}::timestamptz`,
    );
    zero(
      'a response/resolution that happened before the deadline is not marked breached',
      sql`SELECT count(*) FROM tickets WHERE (first_response_breached_at IS NOT NULL AND first_responded_at <= first_response_due) OR (resolution_breached_at IS NOT NULL AND resolved_at <= resolution_due)`,
    );
    zero(
      'linked tickets point to an earlier, closed ticket of the same customer',
      sql`SELECT count(*) FROM tickets t JOIN tickets o ON o.id=t.linked_ticket_id WHERE o.customer_id<>t.customer_id OR o.status<>'closed' OR o.created_at >= t.created_at`,
    );
    zero(
      'ratings only on resolved/closed tickets, by the ticket owner',
      sql`SELECT count(*) FROM ratings r JOIN tickets t ON t.id=r.ticket_id WHERE t.status NOT IN ('resolved','closed') OR t.customer_id<>r.customer_id`,
    );
    zero(
      'history: first event is "created" by the customer; last status event matches the ticket status',
      sql`SELECT count(*) FROM tickets t WHERE
            COALESCE((SELECT new_value FROM ticket_events e WHERE e.ticket_id=t.id AND e.field='status' ORDER BY e.created_at DESC, e.id DESC LIMIT 1),'new') <> t.status::text
         OR NOT EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id=t.id AND e.field='created' AND e.actor_id=t.customer_id)`,
    );
    zero(
      'version equals the number of history events',
      sql`SELECT count(*) FROM tickets t WHERE version <> (SELECT count(*) FROM ticket_events e WHERE e.ticket_id=t.id)`,
    );
    zero(
      'only the system (NULL actor) closes tickets',
      sql`SELECT count(*) FROM ticket_events WHERE field='status' AND new_value='closed' AND actor_id IS NOT NULL`,
    );

    it("stored SLA deadlines equal the shared calculation for the ticket's priority (500-ticket sample)", async () => {
      const sample = await q<{
        priority: keyof typeof DEFAULT_SLA_POLICIES;
        created_at: string;
        first_response_due: string;
        resolution_due: string;
      }>(
        sql`SELECT priority, created_at, first_response_due, resolution_due FROM tickets ORDER BY md5(id::text) LIMIT 500`,
      );
      for (const r of sample) {
        const d = computeDeadlines(new Date(r.created_at), DEFAULT_SLA_POLICIES[r.priority]);
        expect(new Date(r.first_response_due).getTime()).toBe(d.firstResponseDue.getTime());
        expect(new Date(r.resolution_due).getTime()).toBe(d.resolutionDue.getTime());
      }
    });
    it('includes the awkward cases tests and demos need: cross-category assignment, linked tickets, internal notes, tags, breaches, unread, urgent', async () => {
      const need = {
        cross: sql`SELECT count(*) FROM tickets t WHERE assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_categories ac WHERE ac.user_id=t.assignee_id AND ac.category=t.category)`,
        linked: sql`SELECT count(*) FROM tickets WHERE linked_ticket_id IS NOT NULL`,
        notes: sql`SELECT count(*) FROM messages WHERE kind='internal'`,
        tagged: sql`SELECT count(*) FROM tickets WHERE cardinality(tags) > 0`,
        breached: sql`SELECT count(*) FROM tickets WHERE first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL`,
        warned: sql`SELECT count(*) FROM tickets WHERE first_response_warned_at IS NOT NULL`,
        urgent: sql`SELECT count(*) FROM tickets WHERE priority='urgent'`,
        queue: sql`SELECT count(*) FROM tickets WHERE assignee_id IS NULL AND status IN ('new','open')`,
        unreadNotifs: sql`SELECT count(*) FROM notifications WHERE read_at IS NULL`,
        rated: sql`SELECT count(*) FROM ratings`,
      };
      for (const [name, query] of Object.entries(need))
        expect(await one(query), name).toBeGreaterThan(20);
    });
  });

  describe('idempotency & determinism', () => {
    it('a second seed run is a no-op and changes nothing', async () => {
      const before = await one(sql`SELECT count(*) FROM messages`);
      const again = await seed(t, { now: NOW });
      expect(again).toEqual({ skipped: true });
      expect(await one(sql`SELECT count(*) FROM messages`)).toBe(before);
      expect(await one(sql`SELECT count(*) FROM tickets`)).toBe(20_000);
    });
    it('same options → identical dataset content (reproducible)', () => {
      const h = { lead: 'x', agent: 'x', customer: 'x' };
      const strip = (d: ReturnType<typeof generateDataset>) =>
        d.tickets.map((x) => [x.number, x.subject, x.status, x.priority, x.createdAt?.getTime()]);
      const a = generateDataset({ now: NOW, tickets: 300 }, h);
      const b = generateDataset({ now: NOW, tickets: 300 }, h);
      expect(strip(a)).toEqual(strip(b));
      expect(strip(generateDataset({ now: NOW, tickets: 300, rngSeed: 1 }, h))).not.toEqual(
        strip(a),
      );
    });
    it('concurrent seeding on a fresh database (two replicas booting) yields exactly one dataset', async () => {
      const fresh = await createTestDb();
      const other = createDb(fresh.url);
      try {
        const small = {
          now: NOW,
          tickets: 400,
          hashPassword: async (p: string) => `$argon2id$fake$${p}`,
        };
        const [r1, r2] = await Promise.all([seed(fresh, small), seed(other, small)]);
        expect([r1.skipped, r2.skipped].sort()).toEqual([false, true]);
        const n = (await fresh.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM tickets`))
          .rows[0]?.n;
        expect(n).toBe(400);
      } finally {
        await other.close();
        await fresh.drop();
      }
    });
    it('a failing seed rolls back completely (no half-seeded database)', async () => {
      const fresh = await createTestDb();
      try {
        await fresh.db.execute(
          sql`ALTER TABLE ratings ADD CONSTRAINT always_fail CHECK (false) NOT VALID`,
        );
        await expect(
          seed(fresh, { now: NOW, tickets: 500, hashPassword: async () => '$argon2id$fake' }),
        ).rejects.toThrow();
        expect(
          (
            await fresh.db.execute<{ n: number }>(
              sql`SELECT (SELECT count(*) FROM users)::int + (SELECT count(*) FROM tickets)::int n`,
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        await fresh.drop();
      }
    });
  });

  describe('performance budget on 20 000 tickets (assignment: any list query < 200 ms; DB share budget 50 ms)', () => {
    type PlanNode = { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] };
    const explain = async (query: SQL) => {
      const rows = await q<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>(
        sql`EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) ${query}`,
      );
      const root = rows[0]?.['QUERY PLAN'][0];
      if (!root) throw new Error('no plan');
      const nodes: PlanNode[] = [];
      const walk = (n: PlanNode) => {
        nodes.push(n);
        n.Plans?.forEach(walk);
      };
      walk(root.Plan);
      return {
        ms: root['Execution Time'],
        indexes: nodes.flatMap((n) => (n['Index Name'] ? [n['Index Name']] : [])),
        seqScans: nodes.filter((n) => n['Node Type'] === 'Seq Scan').length,
      };
    };
    const BUDGET_MS = 50;
    beforeAll(async () => {
      const [customer] = await q<{ id: string }>(
        sql`SELECT id FROM users WHERE role='customer' LIMIT 1`,
      );
      await t.db.execute(
        sql`INSERT INTO tickets(number,subject,category,customer_id,first_response_due,resolution_due) VALUES (999999,'zzzuniqueterm','other',${customer?.id},now(),now())`,
      );
      await t.db.execute(sql`ANALYZE tickets`);
    });
    const cases: Array<[string, SQL, (string | string[])?]> = [
      [
        'take-next queue',
        sql`SELECT id FROM tickets WHERE assignee_id IS NULL AND status IN ('new','open') AND category IN ('payment','other') ORDER BY priority DESC, sla_due_at ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        'tickets_queue_idx',
      ],
      [
        'list by created (page 1)',
        sql`SELECT * FROM tickets ORDER BY created_at DESC, id DESC LIMIT 50`,
        'tickets_created_idx',
      ],
      [
        'list by created (keyset page)',
        sql`SELECT * FROM tickets WHERE (created_at, id) < ('2026-08-01T00:00:00Z', 'ffffffff-ffff-4fff-bfff-ffffffffffff') ORDER BY created_at DESC, id DESC LIMIT 50`,
        'tickets_created_idx',
      ],
      [
        'list by updated',
        sql`SELECT * FROM tickets ORDER BY updated_at DESC, id DESC LIMIT 50`,
        'tickets_updated_idx',
      ],
      [
        'list by SLA deadline',
        sql`SELECT * FROM tickets WHERE sla_due_at IS NOT NULL ORDER BY sla_due_at ASC, id ASC LIMIT 50`,
        'tickets_sla_due_idx',
      ],
      [
        'status + category filter',
        sql`SELECT * FROM tickets WHERE status='open' AND category='payment' ORDER BY created_at DESC, id DESC LIMIT 50`,
      ],
      [
        '"my open"',
        sql`SELECT * FROM tickets WHERE assignee_id=(SELECT id FROM users WHERE email=${seedEmail.agent(1)}) AND status='open' ORDER BY updated_at DESC, id DESC LIMIT 50`,
        'tickets_assignee_status_idx',
      ],
      [
        'customer "my tickets"',
        sql`SELECT * FROM tickets WHERE customer_id=(SELECT id FROM users WHERE email=${seedEmail.customer(5)}) ORDER BY updated_at DESC, id DESC LIMIT 50`,
        'tickets_customer_idx',
      ],
      [
        'SLA breached',
        sql`SELECT * FROM tickets WHERE (first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL) AND status IN ('new','open') ORDER BY created_at DESC LIMIT 50`,
      ],
      [
        'tag filter',
        sql`SELECT * FROM tickets WHERE tags @> ARRAY['vip'] ORDER BY created_at DESC LIMIT 50`,
      ],
      [
        'period filter',
        sql`SELECT * FROM tickets WHERE created_at BETWEEN '2026-10-01' AND '2026-10-08' ORDER BY created_at DESC LIMIT 50`,
      ],
      [
        'full-text: subject',
        sql`SELECT id FROM tickets WHERE search @@ plainto_tsquery('simple','wrong total') ORDER BY created_at DESC LIMIT 50`,
      ],
      [
        'full-text: subject OR messages',
        sql`SELECT t.id FROM tickets t WHERE t.search @@ plainto_tsquery('simple','скріншот') UNION SELECT m.ticket_id FROM messages m WHERE m.search @@ plainto_tsquery('simple','скріншот')`,
        'messages_search_gin',
      ],
      [
        'ticket timeline',
        sql`SELECT * FROM messages WHERE ticket_id=(SELECT id FROM tickets WHERE number=15000) ORDER BY created_at, id`,
        'messages_ticket_idx',
      ],
      ['ticket by number', sql`SELECT * FROM tickets WHERE number=15000`, 'tickets_number_uq'],
      [
        'SLA scan (job)',
        sql`SELECT id FROM tickets WHERE status IN ('new','open') AND first_responded_at IS NULL AND first_response_breached_at IS NULL AND first_response_due < now()`,
      ],
      [
        'auto-close scan (job)',
        sql`SELECT id FROM tickets WHERE status='resolved' AND resolved_at < now() - interval '3 days'`,
        'tickets_resolved_idx',
      ],
    ];
    it('the GIN index on tickets.search is usable for the search query form (planner may still prefer a 4 ms seq scan at 20k rows)', async () => {
      await t.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const rows = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN (COSTS OFF) SELECT id FROM tickets WHERE search @@ plainto_tsquery('simple','zzzuniqueterm') ORDER BY created_at DESC LIMIT 50`,
        );
        expect(rows.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('tickets_search_gin');
      });
    });
    it.each(cases)('%s', async (_name, query, index) => {
      await explain(query); // warm cache
      const plan = await explain(query);
      expect(plan.ms).toBeLessThan(BUDGET_MS);
      if (index) expect(plan.indexes.some((i) => [index].flat().includes(i))).toBe(true);
    });
  });
});
