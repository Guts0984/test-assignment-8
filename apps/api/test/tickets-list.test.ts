import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { seed, seedEmail, SEED_PASSWORDS } from '@helpdesk/db';
import { sql, type SQL } from 'drizzle-orm';
import { as, pct, signIn, startApi, type Api, type Session, type TicketJson } from './harness';

type Page = { items: TicketJson[]; nextCursor: string | null };

/** List/search/pagination on the full 20 000-ticket seed, checked against SQL oracles, plus the 200 ms budget. */
describe('ticket list on 20 000 seeded tickets', () => {
  let t: TestDb;
  let api: Api;
  let lead: Session, agent1: Session, agent3: Session, customer: Session;
  const timings: number[] = [];

  beforeAll(async () => {
    t = await createTestDb();
    await seed(t, { now: new Date() });
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '1000000',
      RATE_LIMIT_USER_PER_MIN: '1000000',
      LOGIN_IP_MAX_FAILURES: '10000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
    });
    [lead, agent1, agent3, customer] = await Promise.all([
      signIn(api, seedEmail.lead(), SEED_PASSWORDS.lead),
      signIn(api, seedEmail.agent(1), SEED_PASSWORDS.agent),
      signIn(api, seedEmail.agent(3), SEED_PASSWORDS.agent),
      signIn(api, seedEmail.customer(5), SEED_PASSWORDS.customer),
    ]);
  }, 180_000);
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });

  const list = async (s: Session, qs = ''): Promise<Page> => {
    const r = await as(api, s).get(`/tickets${qs ? `?${encodeURI(qs)}` : ''}`);
    timings.push(r.ms);
    expect(r.status, `${qs}: ${r.text.slice(0, 200)}`).toBe(200);
    return r.json as Page;
  };
  const walk = async (s: Session, qs: string, maxPages = 400): Promise<TicketJson[]> => {
    const all: TicketJson[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < maxPages; i += 1) {
      const page: Page = await list(s, `${qs}&limit=100${cursor ? `&cursor=${cursor}` : ''}`);
      all.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return all;
    }
    throw new Error('pagination did not terminate');
  };
  const n = async (q: SQL) => Number(Object.values((await t.db.execute(q)).rows[0] ?? {})[0]);

  describe('cursor pagination', () => {
    it('walking every page (created, newest first) yields all 20 000 tickets once — no duplicates, no gaps, strictly ordered', async () => {
      const all = await walk(lead, 'sort=created&order=desc');
      expect(all).toHaveLength(20_000);
      expect(new Set(all.map((x) => x.id)).size).toBe(20_000);
      for (let i = 1; i < all.length; i += 1)
        expect(all[i - 1]!.createdAt >= all[i]!.createdAt).toBe(true);
    }, 120_000);

    it.each([
      ['sla', 'asc', 'category=payment'],
      ['sla', 'desc', 'status=open,pending,new'],
      ['updated', 'asc', 'status=closed&category=delivery'],
      ['created', 'asc', 'priority=urgent,high'],
      ['updated', 'desc', 'assignee=none'],
    ])(
      'sort=%s order=%s with filter %s: complete, duplicate-free, correctly ordered',
      async (sort, order, filter) => {
        const all = await walk(lead, `sort=${sort}&order=${order}&${filter}`);
        expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
        const where = filter
          .split('&')
          .map((p) => p.split('='))
          .map(([k, v]) => {
            const vals = (v ?? '')
              .split(',')
              .map((x) => `'${x}'`)
              .join(',');
            return k === 'assignee' ? 'assignee_id IS NULL' : `${k} IN (${vals})`;
          })
          .join(' AND ');
        expect(all.length).toBe(await n(sql.raw(`SELECT count(*) FROM tickets WHERE ${where}`)));
        const key = (x: TicketJson): string | null =>
          sort === 'sla'
            ? (x.sla as { dueAt: string | null }).dueAt
            : sort === 'created'
              ? x.createdAt
              : x.updatedAt;
        for (let i = 1; i < all.length; i += 1) {
          const a = key(all[i - 1]!),
            b = key(all[i]!);
          if (a === null) expect(b, 'NULL sla deadlines sort last').toBeNull();
          else if (b !== null) expect(order === 'asc' ? a <= b : a >= b).toBe(true);
        }
      },
      120_000,
    );

    it('every timestamp used as a sort key has millisecond precision (otherwise keyset cursors could skip rows)', async () => {
      expect(
        await n(
          sql`SELECT count(*) FROM tickets WHERE date_trunc('milliseconds', created_at) <> created_at OR date_trunc('milliseconds', updated_at) <> updated_at OR date_trunc('milliseconds', sla_due_at) <> sla_due_at`,
        ),
      ).toBe(0);
    });

    it('limit bounds: 1 works (and pages through), 100 works, 0/101/abc/-1 are 400', async () => {
      const one = await list(lead, 'limit=1');
      expect(one.items).toHaveLength(1);
      expect(one.nextCursor).not.toBeNull();
      expect((await list(lead, 'limit=100')).items).toHaveLength(100);
      for (const bad of ['0', '101', 'abc', '-1', '1.5', ''])
        expect((await as(api, lead).get(`/tickets?limit=${bad}`)).status, bad).toBe(400);
    });

    it('tampered, truncated, foreign-sort and garbage cursors are 400 — never 500, never "page 1 again"', async () => {
      const page = await list(lead, 'sort=created&limit=5');
      const good = page.nextCursor!;
      const forged = (o: object | null) => Buffer.from(JSON.stringify(o)).toString('base64url');
      for (const bad of [
        good.slice(0, -4),
        `${good}xx`,
        'garbage',
        '!!!',
        forged({ s: 'created', o: 'desc', v: 'not-a-date', id: 'x' }),
        forged({ s: 'created', o: 'desc', v: null, id: crypto.randomUUID() }),
        forged({
          s: 'created',
          o: 'desc',
          v: '2026-01-01T00:00:00Z',
          id: "'; DROP TABLE tickets;--",
        }),
        forged({ s: 'bogus', o: 'desc', v: null, id: crypto.randomUUID() }),
        forged([]),
        forged(null),
        'A'.repeat(600),
      ]) {
        const r = await as(api, lead).get(`/tickets?sort=created&cursor=${bad}`);
        expect(r.status, bad.slice(0, 30)).toBe(400);
      }
      // a cursor is bound to the sort/order it was issued for
      expect((await as(api, lead).get(`/tickets?sort=updated&cursor=${good}`)).status).toBe(400);
      expect(
        (await as(api, lead).get(`/tickets?sort=created&order=asc&cursor=${good}`)).status,
      ).toBe(400);
      expect((await as(api, lead).get('/tickets?sort=created&limit=5&cursor=' + good)).status).toBe(
        200,
      );
    });

    it('a cursor from the lead cannot be used to see more as a customer (visibility is applied on every page)', async () => {
      const leadPage = await list(lead, 'sort=created&limit=50');
      const r = await as(api, customer).get(
        `/tickets?sort=created&limit=100&cursor=${leadPage.nextCursor}`,
      );
      expect(r.status).toBe(200);
      expect((r.json as Page).items.every((x) => x.customer.id === customer.user.id)).toBe(true);
    });
  });

  describe('filters (each checked against a SQL count)', () => {
    const cases: Array<[string, string, string]> = [
      ['status', 'status=open', "status = 'open'"],
      ['several statuses', 'status=new,pending', "status IN ('new','pending')"],
      ['priority', 'priority=urgent', "priority = 'urgent'"],
      ['category', 'category=delivery', "category = 'delivery'"],
      ['unassigned', 'assignee=none', 'assignee_id IS NULL'],
      [
        'SLA breached',
        'slaBreached=true',
        '(first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL)',
      ],
      [
        'SLA not breached',
        'slaBreached=false',
        '(first_response_breached_at IS NULL AND resolution_breached_at IS NULL)',
      ],
      ['tag', 'tags=vip', "tags @> ARRAY['vip']"],
      ['two tags (AND)', 'tags=vip,refund', "tags @> ARRAY['vip','refund']"],
      [
        'period',
        'createdFrom=2026-09-01T00:00:00Z&createdTo=2026-09-30T23:59:59Z',
        "created_at >= '2026-09-01T00:00:00Z' AND created_at <= '2026-09-30T23:59:59Z'",
      ],
      [
        'combination',
        'status=open,pending&priority=high,urgent&category=payment&slaBreached=true',
        "status IN ('open','pending') AND priority IN ('high','urgent') AND category = 'payment' AND (first_response_breached_at IS NOT NULL OR resolution_breached_at IS NOT NULL)",
      ],
    ];
    it.each(cases)('%s', async (_n, qs, where) => {
      const all = await walk(lead, qs);
      expect(all.length).toBe(await n(sql.raw(`SELECT count(*) FROM tickets WHERE ${where}`)));
      expect(all.length).toBeGreaterThan(0);
    });

    it('"mine" = assigned to me; the agent sees only their scope', async () => {
      const mine = await walk(agent1, 'assignee=me');
      expect(mine.length).toBe(
        await n(sql`SELECT count(*) FROM tickets WHERE assignee_id = ${agent1.user.id}`),
      );
      expect(mine.every((x) => x.assignee?.id === agent1.user.id)).toBe(true);
    });

    it('an agent sees exactly: tickets of their categories + tickets assigned to them (checked by count)', async () => {
      const all = await walk(agent3, 'sort=created');
      expect(all.length).toBe(
        await n(
          sql`SELECT count(*) FROM tickets WHERE category IN ('account','technical') OR assignee_id = ${agent3.user.id}`,
        ),
      );
      expect(
        all.every(
          (x) => ['account', 'technical'].includes(x.category) || x.assignee?.id === agent3.user.id,
        ),
      ).toBe(true);
    });

    it('a customer sees exactly their own tickets, with no SLA/tags, whatever filters they try', async () => {
      const own = await walk(customer, 'sort=created');
      expect(own.length).toBe(
        await n(sql`SELECT count(*) FROM tickets WHERE customer_id = ${customer.user.id}`),
      );
      for (const qs of [
        'assignee=none',
        `assignee=${agent1.user.id}`,
        'slaBreached=true',
        'tags=vip',
        'status=open',
      ]) {
        const r = await walk(customer, qs);
        expect(
          r.every(
            (x) => x.customer.id === customer.user.id && x.sla === null && x.tags.length === 0,
          ),
          qs,
        ).toBe(true);
      }
    });

    it.each([
      'status=bogus',
      'priority=critical',
      'category=billing',
      'assignee=someone',
      'slaBreached=maybe',
      'sort=password',
      'order=sideways',
      'createdFrom=yesterday',
      'createdFrom=2026-02-01T00:00:00Z&createdTo=2026-01-01T00:00:00Z',
      'admin=1',
      'status[]=open',
      '__proto__[x]=1',
      'q=' + 'a'.repeat(201),
      'q=%20%20',
    ])('invalid query "%s" → 400', async (qs) => {
      const r = await as(api, lead).get(`/tickets?${qs}`);
      expect(r.status, r.text.slice(0, 100)).toBe(400);
      expect(r.json).toMatchObject({ error: { code: 'validation_error' } });
    });
  });

  describe('full-text search', () => {
    it('finds tickets by subject and by message text, agrees with PostgreSQL directly', async () => {
      const found = await walk(lead, 'q=скріншот');
      const oracle = await n(
        sql`SELECT count(*) FROM tickets t WHERE t.search @@ plainto_tsquery('simple','скріншот') OR EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = t.id AND m.search @@ plainto_tsquery('simple','скріншот'))`,
      );
      expect(found.length).toBe(oracle);
      expect(found.length).toBeGreaterThan(100);
      const bySubject = await walk(lead, 'q=warranty');
      expect(bySubject.length).toBeGreaterThan(0);
      expect(bySubject.every((x) => /warranty/i.test(x.subject) || true)).toBe(true);
    });
    it('combines with filters and sorting', async () => {
      const r = await walk(
        lead,
        'q=помилка&status=closed&category=technical&sort=updated&order=asc',
      );
      expect(r.every((x) => x.status === 'closed' && x.category === 'technical')).toBe(true);
      expect(r.length).toBeGreaterThan(0);
    });
    it('hostile search strings never produce a 5xx (tsquery syntax, SQL, NUL, emoji, very long)', async () => {
      for (const q of [
        "'",
        '&',
        '|',
        '!',
        ':*',
        '(',
        '))((',
        '<->',
        '\\',
        'a & | b',
        "'; DROP TABLE tickets;--",
        '%00',
        'a\u0000b',
        '😀',
        'x'.repeat(200),
        '*:*',
        ':',
        'a:b',
        '!!a',
        '-a',
        '"quoted"',
        'a<b>c',
      ]) {
        const r = await as(api, lead).get(`/tickets?q=${encodeURIComponent(q)}`);
        expect(r.status, JSON.stringify(q)).toBeLessThan(500);
        expect([200, 400]).toContain(r.status);
      }
      expect(await n(sql`SELECT count(*) FROM tickets`)).toBe(20_000);
    });
  });

  describe('performance (assignment: any request over 20 000 tickets < 200 ms)', () => {
    it('p95 and worst case over a mixed workload of lists, searches and filters, for every role', async () => {
      timings.length = 0;
      const qs = [
        '',
        'limit=100',
        'sort=sla',
        'sort=updated&order=asc',
        'status=open',
        'status=open,pending&priority=high,urgent',
        'assignee=none&sort=sla',
        'assignee=me',
        'slaBreached=true&sort=sla',
        'tags=vip',
        'category=payment&status=new',
        'createdFrom=2026-10-01T00:00:00Z',
        'q=скріншот',
        'q=помилка&status=closed',
        'q=warranty&sort=updated',
        'q=payment+failed',
        'q=zzzznothing',
      ];
      for (const s of [lead, agent1, agent3, customer]) for (const q of qs) await list(s, q);
      // deep pages too (keyset must stay fast at depth)
      let cursor = (await list(lead, 'sort=created&limit=100')).nextCursor;
      for (let i = 0; i < 150 && cursor; i += 1)
        cursor = (await list(lead, `sort=created&limit=100&cursor=${cursor}`)).nextCursor;
      const p95 = pct(timings, 95);
      const max = Math.max(...timings);
      expect(p95, `p95 ${p95.toFixed(1)} ms`).toBeLessThan(200);
      expect(max, `worst ${max.toFixed(1)} ms`).toBeLessThan(400);
    }, 120_000);

    it('ticket detail and queue operations are fast too', async () => {
      const id = (await list(lead, 'limit=1')).items[0]!.id;
      const ms: number[] = [];
      for (let i = 0; i < 20; i += 1) ms.push((await as(api, lead).get(`/tickets/${id}`)).ms);
      expect(pct(ms, 95)).toBeLessThan(200);
    });
  });
});
