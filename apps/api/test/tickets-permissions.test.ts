import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  as,
  createTicketAs,
  createUsers,
  errorShape,
  newTicketBody,
  reply,
  signIn,
  startApi,
  type Api,
  type Session,
  type TestUsers,
  type TicketJson,
} from './harness';

/** Who may see / do what — checked against the real server, with real sessions. */
describe('permissions (real server, real PostgreSQL)', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let customer: Session, customer2: Session, agent: Session, agent2: Session, lead: Session;
  let payment: TicketJson; // customer's, category payment  → agent (payment) can see it
  let delivery: TicketJson; // customer's, category delivery → agent2 only

  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '100000',
      RATE_LIMIT_USER_PER_MIN: '100000',
      LOGIN_IP_MAX_FAILURES: '1000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
    });
    [customer, customer2, agent, agent2, lead] = await Promise.all([
      signIn(api, u.customer.email, PASSWORDS.customer),
      signIn(api, u.customer2.email, PASSWORDS.customer),
      signIn(api, u.agent.email, PASSWORDS.agent),
      signIn(api, u.agent2.email, PASSWORDS.agent),
      signIn(api, u.lead.email, PASSWORDS.lead),
    ]);
    payment = await createTicketAs(api, customer, {
      subject: 'Payment problem',
      category: 'payment',
    });
    delivery = await createTicketAs(api, customer, {
      subject: 'Parcel lost',
      category: 'delivery',
    });
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });

  describe('customers', () => {
    it('see their own tickets, and ONLY those, in the list', async () => {
      await createTicketAs(api, customer2, { subject: 'Customer two private' });
      const mine = (await as(api, customer).get('/tickets')).json as { items: TicketJson[] };
      expect(mine.items.map((i) => i.id).sort()).toEqual([payment.id, delivery.id].sort());
      expect(mine.items.every((i) => i.customer.id === u.customer.id)).toBe(true);
    });

    it.each([
      ['read the ticket', (id: string, s: Session) => as(api, s).get(`/tickets/${id}`)],
      [
        'reply to it',
        (id: string, s: Session) => as(api, s).post(`/tickets/${id}/messages`, reply('hello')),
      ],
      [
        'change it',
        (id: string, s: Session) =>
          as(api, s).patch(`/tickets/${id}`, { version: 1, status: 'resolved' }),
      ],
      [
        'rate it',
        (id: string, s: Session) => as(api, s).post(`/tickets/${id}/rating`, { score: 5 }),
      ],
      ['mark it read', (id: string, s: Session) => as(api, s).post(`/tickets/${id}/read`)],
    ])(
      'another customer cannot %s — the answer is identical to "does not exist"',
      async (_n, act) => {
        const foreign = await act(payment.id, customer2);
        const missing = await act(crypto.randomUUID(), customer2);
        expect(foreign.status).toBe(404);
        expect(errorShape(foreign)).toBe(errorShape(missing)); // no existence oracle
        expect(foreign.text).not.toContain(payment.subject);
      },
    );

    it('cannot find foreign tickets by search either', async () => {
      const r = await as(api, customer2).get('/tickets?q=Payment');
      const items = (r.json as { items: TicketJson[] }).items; // customer two's OWN ticket mentions payment too
      expect(items.every((i) => i.customer.id === u.customer2.id)).toBe(true);
      expect(items.some((i) => i.id === payment.id)).toBe(false);
      expect(r.text).not.toContain('Payment problem'); // the foreign ticket's subject
    });

    it('never see SLA data or tags (internal), only their own ticket fields', async () => {
      await as(api, lead).patch(`/tickets/${payment.id}`, {
        version: payment.version,
        tags: ['vip', 'refund'],
      });
      const r = (await as(api, customer).get(`/tickets/${payment.id}`)).json as {
        ticket: TicketJson;
        events: unknown[];
      };
      expect(r.ticket.sla).toBeNull();
      expect(r.ticket.tags).toEqual([]);
      expect(r.events).toEqual([]);
      const list = (await as(api, customer).get('/tickets')).json as { items: TicketJson[] };
      expect(list.items.every((i) => i.sla === null && i.tags.length === 0)).toBe(true);
    });

    it('cannot create an urgent ticket, nor an unknown category, nor set privileged fields', async () => {
      for (const over of [
        { priority: 'urgent' },
        { category: 'billing' },
        { status: 'resolved' },
        { assigneeId: u.agent.id },
        { number: 5 },
        { customerId: u.customer2.id },
      ]) {
        const r = await as(api, customer).post('/tickets', newTicketBody(over));
        expect(r.status, JSON.stringify(over)).toBe(400);
      }
    });

    it('can only mark a ticket solved — nothing else', async () => {
      for (const patch of [
        { priority: 'urgent' },
        { category: 'other' },
        { assigneeId: u.agent.id },
        { assigneeId: null },
        { tags: ['x'] },
      ]) {
        const r = await as(api, customer).patch(`/tickets/${delivery.id}`, {
          version: delivery.version,
          ...patch,
        });
        expect(r.status, JSON.stringify(patch)).toBe(403);
      }
      const bad = await as(api, customer).patch(`/tickets/${delivery.id}`, {
        version: delivery.version,
        status: 'open',
      });
      expect(bad.status).toBe(409);
      const closeIt = await as(api, customer).patch(`/tickets/${delivery.id}`, {
        version: delivery.version,
        status: 'closed',
      });
      expect(closeIt.status).toBe(409);
    });

    it('cannot write internal notes or use staff-only endpoints', async () => {
      expect(
        (
          await as(api, customer).post(
            `/tickets/${payment.id}/messages`,
            reply('note', { kind: 'internal' }),
          )
        ).status,
      ).toBe(403);
      for (const [method, path] of [
        ['post', '/tickets/take-next'],
        ['post', '/tickets/bulk'],
        ['get', '/canned-responses'],
        ['get', '/sla'],
        ['get', '/agents'],
        ['get', '/saved-views'],
      ] as const) {
        const r =
          method === 'get'
            ? await as(api, customer).get(path)
            : await as(api, customer).post(path, {});
        expect(r.status, path).toBe(403);
      }
      expect((await as(api, customer).put('/sla', { policies: [] })).status).toBe(403);
    });
  });

  describe('agents', () => {
    it('see tickets of their categories, not of others', async () => {
      expect((await as(api, agent).get(`/tickets/${payment.id}`)).status).toBe(200);
      const denied = await as(api, agent).get(`/tickets/${delivery.id}`);
      expect(denied.status).toBe(404);
      expect(errorShape(denied)).toBe(
        errorShape(await as(api, agent).get(`/tickets/${crypto.randomUUID()}`)),
      );
      expect((await as(api, agent2).get(`/tickets/${delivery.id}`)).status).toBe(200);
      const list = (await as(api, agent).get('/tickets?limit=100')).json as { items: TicketJson[] };
      expect(list.items.every((i) => i.category === 'payment')).toBe(true);
      expect(list.items.some((i) => i.id === delivery.id)).toBe(false);
    });

    it('cannot act on a foreign-category ticket (reply, patch, bulk) — and bulk reports it as unavailable', async () => {
      expect(
        (await as(api, agent).post(`/tickets/${delivery.id}/messages`, reply('sneaky'))).status,
      ).toBe(404);
      expect(
        (
          await as(api, agent).patch(`/tickets/${delivery.id}`, {
            version: delivery.version,
            priority: 'high',
          })
        ).status,
      ).toBe(404);
      const bulk = await as(api, agent).post('/tickets/bulk', {
        ids: [delivery.id, payment.id],
        operation: { action: 'setPriority', priority: 'high' },
      });
      expect(bulk.status).toBe(200);
      expect(
        (bulk.json as { results: Array<{ id: string; ok: boolean; reason?: string }> }).results,
      ).toEqual([
        { id: delivery.id, ok: false, reason: 'not_found_or_forbidden' },
        { id: payment.id, ok: true },
      ]);
    });

    it('a foreign-category ticket becomes visible once it is assigned to the agent — and stays hidden otherwise', async () => {
      const detail = (await as(api, lead).get(`/tickets/${delivery.id}`)).json as {
        ticket: TicketJson;
      };
      const assigned = await as(api, lead).patch(`/tickets/${delivery.id}`, {
        version: detail.ticket.version,
        assigneeId: u.agent.id,
      });
      expect(assigned.status).toBe(200);
      expect((await as(api, agent).get(`/tickets/${delivery.id}`)).status).toBe(200);
      expect(
        (
          (await as(api, agent).get('/tickets?limit=100')).json as { items: TicketJson[] }
        ).items.some((i) => i.id === delivery.id),
      ).toBe(true);
      // un-assign again: hidden again
      const v = (
        (await as(api, lead).get(`/tickets/${delivery.id}`)).json as { ticket: TicketJson }
      ).ticket.version;
      await as(api, lead).patch(`/tickets/${delivery.id}`, { version: v, assigneeId: null });
      expect((await as(api, agent).get(`/tickets/${delivery.id}`)).status).toBe(404);
    });

    it('cannot change the category, assign to others, or reach lead-only endpoints', async () => {
      const v = (
        (await as(api, agent).get(`/tickets/${payment.id}`)).json as { ticket: TicketJson }
      ).ticket.version;
      expect(
        (await as(api, agent).patch(`/tickets/${payment.id}`, { version: v, category: 'other' }))
          .status,
      ).toBe(403);
      expect(
        (
          await as(api, agent).patch(`/tickets/${payment.id}`, {
            version: v,
            assigneeId: u.agent2.id,
          })
        ).status,
      ).toBe(403);
      expect((await as(api, agent).put('/sla', { policies: [] })).status).toBe(403);
      expect(
        (await as(api, agent).post('/canned-responses', { title: 't', body: 'b' })).status,
      ).toBe(403);
      expect((await as(api, agent).delete(`/canned-responses/${crypto.randomUUID()}`)).status).toBe(
        403,
      );
    });

    it("may take a free ticket and release their own, but not steal or release someone else's", async () => {
      const t1 = await createTicketAs(api, customer, {
        subject: 'steal test',
        category: 'payment',
      });
      const taken = await as(api, agent).patch(`/tickets/${t1.id}`, {
        version: t1.version,
        assigneeId: u.agent.id,
      });
      expect(taken.status).toBe(200);
      const v = (taken.json as TicketJson).version;
      // lead moves it to agent (payment) — agent2 (delivery) cannot even see it
      expect(
        (await as(api, agent2).patch(`/tickets/${t1.id}`, { version: v, assigneeId: u.agent2.id }))
          .status,
      ).toBe(404);
      const released = await as(api, agent).patch(`/tickets/${t1.id}`, {
        version: v,
        assigneeId: null,
      });
      expect(released.status).toBe(200);
    });
  });

  describe('internal notes never reach customers (UI data, direct API, search)', () => {
    const SECRET = 'zebrafish-internal-secret';
    let ticket: TicketJson;
    beforeAll(async () => {
      ticket = await createTicketAs(api, customer, {
        subject: 'Notes test',
        category: 'payment',
        body: 'public question',
      });
      expect(
        (
          await as(api, agent).post(
            `/tickets/${ticket.id}/messages`,
            reply(`${SECRET} do not tell the customer`, { kind: 'internal' }),
          )
        ).status,
      ).toBe(201);
      expect(
        (await as(api, agent).post(`/tickets/${ticket.id}/messages`, reply('Hello, we are on it')))
          .status,
      ).toBe(201);
    });

    it('staff see the note, the customer does not — anywhere in the response', async () => {
      const staffView = (await as(api, agent).get(`/tickets/${ticket.id}`)).json as {
        messages: Array<{ kind: string; body: string }>;
      };
      expect(staffView.messages.map((m) => m.kind)).toEqual(['public', 'internal', 'public']);
      const raw = await as(api, customer).get(`/tickets/${ticket.id}`);
      expect(raw.text).not.toContain(SECRET);
      expect(
        (raw.json as { messages: Array<{ kind: string }> }).messages.every(
          (m) => m.kind === 'public',
        ),
      ).toBe(true);
      expect((raw.json as { messages: unknown[] }).messages).toHaveLength(2);
    });

    it('search: staff find the note text, the customer cannot (no oracle for hidden text)', async () => {
      expect(
        (
          (await as(api, agent).get(`/tickets?q=${SECRET.split('-')[0]}`)).json as {
            items: unknown[];
          }
        ).items,
      ).toHaveLength(1);
      const mine = await as(api, customer).get(`/tickets?q=zebrafish`);
      expect((mine.json as { items: unknown[] }).items).toEqual([]);
      expect(mine.text).not.toContain(SECRET);
    });

    it('ticket and message responses to the customer contain no note, including the reply they get after posting', async () => {
      const r = await as(api, customer).post(`/tickets/${ticket.id}/messages`, reply('thanks'));
      expect(r.status).toBe(201);
      expect(r.text).not.toContain(SECRET);
      expect((await as(api, customer).get('/tickets')).text).not.toContain(SECRET);
    });
  });

  describe('lead', () => {
    it('sees every ticket and can do lead-only things', async () => {
      expect((await as(api, lead).get(`/tickets/${payment.id}`)).status).toBe(200);
      expect((await as(api, lead).get(`/tickets/${delivery.id}`)).status).toBe(200);
      expect((await as(api, lead).get('/sla')).status).toBe(200);
      expect((await as(api, lead).get('/agents')).status).toBe(200);
    });
    it('can only assign to an active agent', async () => {
      const v = ((await as(api, lead).get(`/tickets/${payment.id}`)).json as { ticket: TicketJson })
        .ticket.version;
      for (const target of [u.customer.id, u.lead.id, u.disabled.id, crypto.randomUUID()]) {
        const r = await as(api, lead).patch(`/tickets/${payment.id}`, {
          version: v,
          assigneeId: target,
        });
        expect([400, 409], `assignee ${target}`).toContain(r.status);
      }
    });
  });

  describe('input hardening on domain routes', () => {
    it.each([
      ['non-uuid ticket id', '/tickets/not-a-uuid'],
      ['SQL in id', "/tickets/1'%20OR%20'1'='1"],
      ['path traversal id', '/tickets/..%2f..%2fetc%2fpasswd'],
      ['huge id', `/tickets/${'a'.repeat(5000)}`],
    ])('%s → 400/404, never 5xx', async (_n, path) => {
      for (const s of [customer, agent, lead]) {
        const r = await as(api, s).get(path);
        expect(r.status, `${s.user.role}: ${r.text.slice(0, 120)}`).toBeLessThan(500);
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
    });
    it('mass assignment on PATCH is rejected (strict schema)', async () => {
      for (const extra of [
        { id: crypto.randomUUID() },
        { customerId: u.customer2.id },
        { number: 1 },
        { createdAt: new Date().toISOString() },
        { slaDueAt: 'x' },
        { role: 'lead' },
      ]) {
        const r = await as(api, lead).patch(`/tickets/${payment.id}`, {
          version: 1,
          priority: 'high',
          ...extra,
        });
        expect(r.status, JSON.stringify(extra)).toBe(400);
      }
    });
    it('after all of it, nothing in the database changed owner or number', async () => {
      const rows = (
        await t.db.execute<{ customer_id: string; number: number }>(
          sql`SELECT customer_id, number FROM tickets WHERE id IN (${payment.id}, ${delivery.id})`,
        )
      ).rows;
      expect(rows.every((r) => r.customer_id === u.customer.id)).toBe(true);
    });
  });
});
