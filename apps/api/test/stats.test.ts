import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  as,
  createUsers,
  request,
  signIn,
  startApi,
  type Api,
  type Session,
  type TestUsers,
} from './harness';

type Stats = {
  created: number;
  resolved: number;
  avgFirstResponseSeconds: number | null;
  avgResolutionSeconds: number | null;
  slaBreachPercent: number | null;
  avgRating: number | null;
  ratingCount: number;
  workload: Array<{
    agent: { id: string; name: string };
    active: number;
    resolvedInPeriod: number;
    breached: number;
  }>;
};

/** Numbers are checked against a tiny fixture computed by hand. */
describe('GET /stats (lead only)', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let lead: Session, agent: Session, customer: Session;
  const iso = (s: string) => new Date(s);
  const period = 'from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z';
  let seq = 7000;

  const insert = async (o: {
    created: string;
    first?: string;
    resolved?: string;
    status?: string;
    assignee?: string | null;
    breached?: boolean;
  }) => {
    seq += 1;
    const created = iso(o.created);
    const r = await t.db.execute<{ id: string }>(sql`
      INSERT INTO tickets (number, subject, category, status, customer_id, assignee_id, created_at, updated_at, first_response_due, resolution_due, first_responded_at, resolved_at, closed_at, first_response_breached_at)
      VALUES (${seq}, 's', 'payment', ${o.status ?? 'open'}, ${u.customer.id}, ${o.assignee === undefined ? u.agent.id : o.assignee}, ${created}, ${created}, ${new Date(created.getTime() + 3_600_000)}, ${new Date(created.getTime() + 7_200_000)},
              ${o.first ? iso(o.first) : null}, ${o.resolved ? iso(o.resolved) : null}, ${o.status === 'closed' && o.resolved ? iso(o.resolved) : null}, ${o.breached ? new Date(created.getTime() + 3_600_000) : null})
      RETURNING id`);
    return r.rows[0]!.id;
  };

  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '100000',
      RATE_LIMIT_USER_PER_MIN: '100000',
      LOGIN_IP_MAX_FAILURES: '10000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
    });
    [lead, agent, customer] = await Promise.all([
      signIn(api, u.lead.email, PASSWORDS.lead),
      signIn(api, u.agent.email, PASSWORDS.agent),
      signIn(api, u.customer.email, PASSWORDS.customer),
    ]);
    // A: created 10:00, first reply 10:30 (1800 s), resolved 12:00 (7200 s), rated 5
    const a = await insert({
      created: '2026-10-01T10:00:00Z',
      first: '2026-10-01T10:30:00Z',
      resolved: '2026-10-01T12:00:00Z',
      status: 'resolved',
      breached: true,
    });
    // B: created 11:00, first reply 12:00 (3600 s), resolved 15:00 (14400 s), rated 3
    const b = await insert({
      created: '2026-10-01T11:00:00Z',
      first: '2026-10-01T12:00:00Z',
      resolved: '2026-10-01T15:00:00Z',
      status: 'closed',
      assignee: u.agent2.id,
    });
    // C: created 13:00, never answered, still open (assigned to agent), breached
    await insert({ created: '2026-10-01T13:00:00Z', breached: true });
    // D: created the day before, but RESOLVED inside the period
    await insert({
      created: '2026-09-30T09:00:00Z',
      first: '2026-09-30T09:10:00Z',
      resolved: '2026-10-01T09:00:00Z',
      status: 'resolved',
    });
    // E: created after the period
    await insert({ created: '2026-10-03T09:00:00Z' });
    // F: pending, assigned to agent2, created in period, answered 600 s after creation
    await insert({
      created: '2026-10-01T16:00:00Z',
      first: '2026-10-01T16:10:00Z',
      status: 'pending',
      assignee: u.agent2.id,
    });
    for (const [id, score, at] of [
      [a, 5, '2026-10-01T13:00:00Z'],
      [b, 3, '2026-10-01T16:00:00Z'],
    ] as const) {
      await t.db.execute(
        sql`INSERT INTO ratings (ticket_id, customer_id, score, created_at) VALUES (${id}, ${u.customer.id}, ${score}, ${iso(at)})`,
      );
    }
    await t.db.execute(
      sql`INSERT INTO ratings (ticket_id, customer_id, score, created_at) VALUES (${await insert({ created: '2026-09-01T00:00:00Z', status: 'closed', resolved: '2026-09-02T00:00:00Z' })}, ${u.customer.id}, 1, ${iso('2026-09-05T00:00:00Z')})`,
    ); // outside the period
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });
  const get = async (qs: string, s = lead) => as(api, s).get(`/stats?${encodeURI(qs)}`);

  it('computes every figure of the assignment for a period', async () => {
    const r = await get(period);
    expect(r.status).toBe(200);
    const s = r.json as Stats;
    expect(s.created).toBe(4); // A, B, C, F
    expect(s.resolved).toBe(3); // A, B, D resolved inside the period
    expect(s.avgFirstResponseSeconds).toBe((1800 + 3600 + 600) / 3); // created-in-period tickets that were answered: A, B, F
    expect(s.avgResolutionSeconds).toBe((7200 + 14400 + 24 * 3600) / 3); // A, B, D
    expect(s.slaBreachPercent).toBe(50); // A and C of the four created
    expect(s.avgRating).toBe(4);
    expect(s.ratingCount).toBe(2);
  });

  it('shows the load per agent: active tickets, resolved in the period, breaches', async () => {
    const s = (await get(period)).json as Stats;
    const byName = Object.fromEntries(s.workload.map((w) => [w.agent.name, w]));
    // agent one: A (resolved), C (open, breached), D (resolved), E (open, created after the period), + the closed rating-fixture ticket
    expect(byName['Agent One']).toMatchObject({ active: 2, resolvedInPeriod: 2, breached: 2 });
    // agent two: B (closed, resolved in period), F (pending)
    expect(byName['Agent Two']).toMatchObject({ active: 1, resolvedInPeriod: 1, breached: 0 });
    expect(s.workload.some((w) => w.agent.id === u.lead.id)).toBe(false); // agents only
  });

  it('an empty period gives zeros and nulls (not NaN, not an error)', async () => {
    const s = (await get('from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z')).json as Stats;
    expect(s).toMatchObject({
      created: 0,
      resolved: 0,
      avgFirstResponseSeconds: null,
      avgResolutionSeconds: null,
      slaBreachPercent: null,
      avgRating: null,
      ratingCount: 0,
    });
  });

  it('is for the lead only', async () => {
    expect((await get(period, agent)).status).toBe(403);
    expect((await get(period, customer)).status).toBe(403);
    expect((await request401()).status).toBe(401);
  });
  const request401 = async () => request(api, { path: `/stats?${period}` });

  it.each([
    '',
    'from=2026-10-01T00:00:00Z',
    'to=2026-10-01T00:00:00Z',
    'from=yesterday&to=today',
    'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
    'from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:00Z',
    `${period}&extra=1`,
    "from=2026-10-01T00:00:00Z&to='; DROP TABLE tickets;--",
  ])('invalid period "%s" → 400', async (qs) => {
    const r = await get(qs);
    expect(r.status, r.text.slice(0, 100)).toBe(400);
  });

  it('answers a half-year over 20 000 tickets quickly (seeded database)', async () => {
    const big = await createTestDb();
    const { seed, seedEmail, SEED_PASSWORDS } = await import('@helpdesk/db');
    await seed(big, { now: new Date() });
    const own = await startApi(big.url, {
      RATE_LIMIT_API_PER_MIN: '100000',
      RATE_LIMIT_USER_PER_MIN: '100000',
    });
    try {
      const l = await signIn(own, seedEmail.lead(), SEED_PASSWORDS.lead);
      const from = new Date(Date.now() - 190 * 86_400_000).toISOString();
      const r = await as(own, l).get(`/stats?from=${from}&to=${new Date().toISOString()}`);
      expect(r.status).toBe(200);
      const s = r.json as Stats;
      expect(s.created).toBe(20_000);
      expect(s.workload).toHaveLength(6);
      expect(r.ms).toBeLessThan(500);
    } finally {
      await own.stop();
      await big.drop();
    }
  }, 120_000);
});
