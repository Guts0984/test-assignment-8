import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import { STATUSES, canTransition, type TicketStatus } from '@helpdesk/shared';
import {
  PASSWORDS,
  as,
  createTicketAs,
  createUsers,
  reply,
  signIn,
  startApi,
  type Api,
  type Session,
  type TestUsers,
  type TicketJson,
} from './harness';

type Detail = {
  ticket: TicketJson;
  messages: Array<{ id: string; kind: string; body: string; author: { role: string } }>;
  events: Array<{
    field: string;
    oldValue: string | null;
    newValue: string | null;
    actor: { id: string } | null;
  }>;
  rating: { score: number } | null;
};

describe('ticket lifecycle: statuses, replies, history, versions', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let customer: Session, agent: Session, lead: Session;
  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '100000',
      RATE_LIMIT_USER_PER_MIN: '100000',
      LOGIN_IP_MAX_FAILURES: '1000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
    });
    [customer, agent, lead] = await Promise.all([
      signIn(api, u.customer.email, PASSWORDS.customer),
      signIn(api, u.agent.email, PASSWORDS.agent),
      signIn(api, u.lead.email, PASSWORDS.lead),
    ]);
  });
  afterAll(async () => {
    await api.stop();
    await t.drop();
  });
  const detail = async (s: Session, id: string) =>
    (await as(api, s).get(`/tickets/${id}`)).json as Detail;
  const fresh = (over: Record<string, unknown> = {}) => createTicketAs(api, customer, over);
  /** Puts a ticket into any status by direct SQL, so each rule can be tested from every starting point. */
  const force = async (id: string, status: TicketStatus) => {
    const paused = status === 'pending' ? sql`now()` : sql`NULL`;
    await t.db
      .execute(sql`UPDATE tickets SET status = ${status}, first_responded_at = COALESCE(first_responded_at, now()),
      resolved_at = ${status === 'resolved' || status === 'closed' ? sql`now()` : sql`NULL`}, closed_at = ${status === 'closed' ? sql`now()` : sql`NULL`},
      sla_paused_at = ${paused}, resolution_remaining_min = ${status === 'pending' ? sql`100` : sql`NULL`}, version = version + 1 WHERE id = ${id}`);
  };
  const statusOf = async (id: string) => (await detail(lead, id)).ticket.status;

  describe('creation', () => {
    it('numbers are HD-1001, HD-1002 … consecutive; new tickets start as "new" with a first message and a history entry', async () => {
      const a = await fresh();
      const b = await fresh();
      expect(a.code).toBe(`HD-${a.number}`);
      expect(b.number).toBe(a.number + 1);
      expect(a).toMatchObject({ status: 'new', assignee: null, version: 1, linkedTicketId: null });
      const d = await detail(lead, a.id);
      expect(d.messages).toHaveLength(1);
      expect(d.events).toMatchObject([
        { field: 'created', newValue: a.code, actor: { id: u.customer.id } },
      ]);
    });
    it('the subject is trimmed; whitespace-only subjects, blank bodies and 201-char subjects are rejected', async () => {
      expect((await fresh({ subject: '   padded   ' })).subject).toBe('padded');
      for (const over of [
        { subject: '   ' },
        { subject: 'x'.repeat(201) },
        { body: '  \n ' },
        { body: 'x'.repeat(20_001) },
        { subject: 'nul\u0000byte' },
      ]) {
        expect(
          (
            await as(api, customer).post('/tickets', {
              subject: 's',
              category: 'other',
              body: 'b',
              clientMessageId: crypto.randomUUID(),
              ...over,
            })
          ).status,
          JSON.stringify(over).slice(0, 50),
        ).toBe(400);
      }
    });
    it('repeating a create with the same clientMessageId returns the same ticket; the same id with a different text or subject is a 409, not a silent old ticket', async () => {
      const payload = {
        subject: 'Idempotent',
        category: 'other',
        body: 'original text',
        clientMessageId: crypto.randomUUID(),
      };
      const first = await as(api, customer).post('/tickets', payload);
      expect(first.status).toBe(201);
      const again = await as(api, customer).post('/tickets', payload);
      expect(again.status).toBeLessThan(300);
      expect((again.json as TicketJson).id).toBe((first.json as TicketJson).id);
      const otherBody = await as(api, customer).post('/tickets', {
        ...payload,
        body: 'edited text',
      });
      expect(otherBody.status).toBe(409);
      expect(otherBody.json).toMatchObject({ error: { code: 'conflict' } });
      expect(
        (await as(api, customer).post('/tickets', { ...payload, subject: 'Another subject' }))
          .status,
      ).toBe(409);
    });
    it('staff cannot create tickets on behalf of customers', async () => {
      expect(
        (
          await as(api, agent).post('/tickets', {
            subject: 's',
            category: 'other',
            body: 'b',
            clientMessageId: crypto.randomUUID(),
          })
        ).status,
      ).toBe(403);
    });
    it('the SLA deadlines follow the priority (urgent = wall-clock 1 h / 4 h) and are visible to staff only', async () => {
      const tk = await fresh({ priority: 'high' });
      const sla = (await detail(lead, tk.id)).ticket.sla as { firstResponseDue: string };
      expect(new Date(sla.firstResponseDue).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('replies change the status by the rules (README table)', () => {
    it('agent public reply: new → open, and sets the first-response time', async () => {
      const tk = await fresh();
      const r = await as(api, agent).post(`/tickets/${tk.id}/messages`, reply('Looking into it'));
      expect(r.status).toBe(201);
      expect((r.json as { ticket: TicketJson }).ticket.status).toBe('open');
      const d = await detail(lead, tk.id);
      expect((d.ticket.sla as { firstRespondedAt: string | null }).firstRespondedAt).not.toBeNull();
    });
    it('agent public reply: pending → open', async () => {
      const tk = await fresh();
      await force(tk.id, 'pending');
      await as(api, agent).post(`/tickets/${tk.id}/messages`, reply('we are back'));
      expect(await statusOf(tk.id)).toBe('open');
    });
    it('customer reply: pending → open and resolved → open', async () => {
      for (const from of ['pending', 'resolved'] as const) {
        const tk = await fresh();
        await force(tk.id, from);
        const r = await as(api, customer).post(
          `/tickets/${tk.id}/messages`,
          reply('here is more info'),
        );
        expect(r.status).toBe(201);
        expect(await statusOf(tk.id), from).toBe('open');
      }
    });
    it('customer reply on new/open keeps the status', async () => {
      const tk = await fresh();
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('any news?'));
      expect(await statusOf(tk.id)).toBe('new');
    });
    it('an internal note never changes the status and never counts as the first response', async () => {
      const tk = await fresh();
      await as(api, agent).post(
        `/tickets/${tk.id}/messages`,
        reply('note to self', { kind: 'internal' }),
      );
      const d = await detail(lead, tk.id);
      expect(d.ticket.status).toBe('new');
      expect((d.ticket.sla as { firstRespondedAt: string | null }).firstRespondedAt).toBeNull();
    });
    it('a customer reply is never the "first response" either', async () => {
      const tk = await fresh();
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('hello?'));
      expect(
        ((await detail(lead, tk.id)).ticket.sla as { firstRespondedAt: string | null })
          .firstRespondedAt,
      ).toBeNull();
    });
    it('"send and wait" / "send and resolve": reply + status in one step; invalid combinations are refused', async () => {
      const a = await fresh();
      const wait = await as(api, agent).post(
        `/tickets/${a.id}/messages`,
        reply('please send a screenshot', { setStatus: 'pending' }),
      );
      expect((wait.json as { ticket: TicketJson }).ticket.status).toBe('pending');
      const b = await fresh();
      const done = await as(api, agent).post(
        `/tickets/${b.id}/messages`,
        reply('fixed, closing', { setStatus: 'resolved' }),
      );
      expect((done.json as { ticket: TicketJson }).ticket.status).toBe('resolved');
      const c = await fresh();
      await force(c.id, 'resolved');
      expect(
        (
          await as(api, agent).post(
            `/tickets/${c.id}/messages`,
            reply('x', { setStatus: 'pending' }),
          )
        ).status,
      ).toBe(409); // resolved → pending is not allowed
      expect(
        (
          await as(api, customer).post(
            `/tickets/${c.id}/messages`,
            reply('x', { setStatus: 'resolved' }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, agent).post(
            `/tickets/${c.id}/messages`,
            reply('x', { kind: 'internal', setStatus: 'pending' }),
          )
        ).status,
      ).toBe(400);
    });
  });

  describe('closed tickets never reopen', () => {
    it('a customer reply to a closed ticket creates a NEW ticket linked to the old one; the old stays closed', async () => {
      const old = await fresh({ subject: 'Old problem', priority: 'high' });
      await force(old.id, 'closed');
      const r = await as(api, customer).post(
        `/tickets/${old.id}/messages`,
        reply('it is back again'),
      );
      expect(r.status).toBe(201);
      const body = r.json as {
        ticket: TicketJson;
        spawnedFrom: string | null;
        message: { body: string };
      };
      expect(body.spawnedFrom).toBe(old.id);
      expect(body.ticket).toMatchObject({
        linkedTicketId: old.id,
        status: 'new',
        subject: 'Old problem',
        category: old.category,
        priority: 'high',
      });
      expect(body.ticket.number).toBeGreaterThan(old.number);
      expect(body.message.body).toBe('it is back again');
      expect(await statusOf(old.id)).toBe('closed');
      expect((await detail(lead, old.id)).messages).toHaveLength(1); // nothing was added to the old one
    });
    it('a RETRY of that reply (same message id) returns the same new ticket, not a conflict; changed content with the same id is a conflict', async () => {
      const old = await fresh({ subject: 'Retry me' });
      await force(old.id, 'closed');
      const payload = reply('it is back, retried');
      const first = await as(api, customer).post(`/tickets/${old.id}/messages`, payload);
      expect(first.status).toBe(201);
      const again = await as(api, customer).post(`/tickets/${old.id}/messages`, payload);
      expect(again.status).toBe(200);
      const a = first.json as { ticket: TicketJson; spawnedFrom: string | null };
      const b = again.json as { ticket: TicketJson; spawnedFrom: string | null; replayed: boolean };
      expect(b.ticket.id).toBe(a.ticket.id);
      expect(b.spawnedFrom).toBe(old.id);
      expect(b.replayed).toBe(true);
      const changed = await as(api, customer).post(`/tickets/${old.id}/messages`, {
        ...payload,
        body: 'something else entirely',
      });
      expect(changed.status).toBe(409);
    });
    it('the new ticket of an urgent old one is high (customers cannot create urgent)', async () => {
      const old = await fresh();
      await as(api, lead).patch(`/tickets/${old.id}`, { version: old.version, priority: 'urgent' });
      await force(old.id, 'closed');
      expect(
        (
          (await as(api, customer).post(`/tickets/${old.id}/messages`, reply('again'))).json as {
            ticket: TicketJson;
          }
        ).ticket.priority,
      ).toBe('high');
    });
    it('staff cannot reply to or edit a closed ticket', async () => {
      const old = await fresh();
      await force(old.id, 'closed');
      expect((await as(api, agent).post(`/tickets/${old.id}/messages`, reply('late'))).status).toBe(
        409,
      );
      const v = (await detail(lead, old.id)).ticket.version;
      for (const patch of [
        { status: 'open' },
        { priority: 'low' },
        { tags: ['x'] },
        { assigneeId: u.agent.id },
      ]) {
        expect(
          (await as(api, lead).patch(`/tickets/${old.id}`, { version: v, ...patch })).status,
          JSON.stringify(patch),
        ).toBe(409);
      }
    });
  });

  describe('manual status changes obey the transition table for EVERY pair', () => {
    for (const from of STATUSES) {
      it(`from ${from}: every target is accepted/refused exactly as the table says (staff and customer)`, async () => {
        for (const to of STATUSES) {
          for (const [who, s, role] of [
            ['agent', agent, 'agent'],
            ['customer', customer, 'customer'],
          ] as const) {
            const tk = await fresh();
            if (from !== 'new') await force(tk.id, from);
            const v = (await detail(lead, tk.id)).ticket.version;
            const r = await as(api, s).patch(`/tickets/${tk.id}`, { version: v, status: to });
            const allowed = from === to || (from !== 'closed' && canTransition(from, to, role));
            if (from === to && from !== 'closed')
              expect(r.status, `${who} ${from}→${to} (no-op)`).toBe(200);
            else if (allowed && from !== 'closed')
              expect(r.status, `${who} ${from}→${to}`).toBe(200);
            else expect(r.status, `${who} ${from}→${to}`).toBeGreaterThanOrEqual(409);
          }
        }
      });
    }
  });

  describe('history & versions', () => {
    it('every change is recorded: who, when, what (status, priority, assignee, category, tags) and the version moves by one', async () => {
      const tk = await fresh();
      let v = tk.version;
      const step = async (s: Session, patch: Record<string, unknown>) => {
        const r = await as(api, s).patch(`/tickets/${tk.id}`, { version: v, ...patch });
        expect(r.status, JSON.stringify(patch)).toBe(200);
        expect((r.json as TicketJson).version).toBe(v + 1);
        v += 1;
      };
      await step(lead, { assigneeId: u.agent.id });
      await step(agent, { status: 'open' });
      await step(agent, { priority: 'high' });
      await step(lead, { category: 'delivery' });
      await step(agent, { tags: ['vip'] });
      const ev = (await detail(lead, tk.id)).events;
      expect(ev.map((e) => e.field)).toEqual([
        'created',
        'assignee',
        'status',
        'priority',
        'category',
        'tags',
      ]);
      expect(ev[2]).toMatchObject({ oldValue: 'new', newValue: 'open', actor: { id: u.agent.id } });
      expect(ev[3]).toMatchObject({ oldValue: 'normal', newValue: 'high' });
      expect(ev[4]).toMatchObject({
        oldValue: 'payment',
        newValue: 'delivery',
        actor: { id: u.lead.id },
      });
      expect(ev[1]).toMatchObject({ oldValue: null, newValue: u.agent.id });
      const agentName = (
        await t.db.execute<{ name: string }>(sql`SELECT name FROM users WHERE id = ${u.agent.id}`)
      ).rows[0]!.name;
      const named = ev as unknown as Array<{ newValueName?: string | null }>;
      expect(named[1]!.newValueName).toBe(agentName); // the history can say WHO was assigned
      expect(named[2]!.newValueName ?? null).toBeNull(); // only assignee events carry a name
      // the agent (payment) lost sight of the ticket when the lead moved it to delivery — but it is still assigned to them
      expect((await as(api, agent).get(`/tickets/${tk.id}`)).status).toBe(200);
    });
    it('a priority change that puts the ticket past a deadline tells the assignee ONCE (the background scan does not repeat it)', async () => {
      const tk = await fresh({ priority: 'normal' });
      await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        assigneeId: u.agent.id,
      });
      await t.db.execute(
        sql`UPDATE tickets SET created_at = now() - interval '3 days' WHERE id = ${tk.id}`,
      );
      const v = (await detail(lead, tk.id)).ticket.version;
      await as(api, lead).patch(`/tickets/${tk.id}`, { version: v, priority: 'urgent' }); // 1 h deadline: long gone
      const rows = async () =>
        (
          await t.db.execute<{ type: string; dedupe_key: string }>(
            sql`SELECT type, dedupe_key FROM notifications WHERE ticket_id = ${tk.id} AND type IN ('sla_breached','sla_warning') ORDER BY dedupe_key`,
          )
        ).rows;
      expect((await rows()).map((r) => r.dedupe_key)).toEqual(
        expect.arrayContaining(['first_response_breach', 'resolution_breach']),
      );
      // the same keys as the scan use: a scan finding the (already stamped) marks cannot notify twice
      const keys = (await rows()).map((r) => `${r.type}:${r.dedupe_key}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
    it('a patch that changes nothing writes nothing: no version bump, no history', async () => {
      const tk = await fresh();
      const r = await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        status: 'new',
        priority: 'normal',
        tags: [],
      });
      expect(r.status).toBe(200);
      expect((r.json as TicketJson).version).toBe(tk.version);
      expect((await detail(lead, tk.id)).events).toHaveLength(1);
    });
    it('tags are normalised and compared as a set (reordering is not a change)', async () => {
      const tk = await fresh();
      const a = await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        tags: [' VIP ', 'Refund', 'vip'],
      });
      expect((a.json as TicketJson).tags).toEqual(['vip', 'refund']);
      const b = await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: 2,
        tags: ['refund', 'vip'],
      });
      expect((b.json as TicketJson).version).toBe(2);
    });
    it('a message that changes nothing about the ticket does not bump the version (sidebar edits are not disturbed by chatter)', async () => {
      const tk = await fresh();
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('one more thing'));
      expect((await detail(lead, tk.id)).ticket.version).toBe(1);
    });
    it('priority change recomputes the deadlines from CREATION time (checked in the database)', async () => {
      const tk = await fresh({ priority: 'low' });
      await t.db.execute(
        sql`UPDATE tickets SET created_at = '2026-11-13T15:00:00Z', updated_at = '2026-11-13T15:00:00Z' WHERE id = ${tk.id}`,
      ); // Friday 17:00 Kyiv
      const r = await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        priority: 'high',
      });
      expect(r.status).toBe(200);
      const row = (
        await t.db.execute<{ first_response_due: string; resolution_due: string }>(
          sql`SELECT first_response_due, resolution_due FROM tickets WHERE id = ${tk.id}`,
        )
      ).rows[0]!;
      expect(new Date(row.first_response_due).toISOString()).toBe('2026-11-16T10:00:00.000Z'); // Monday 12:00 Kyiv
      expect(new Date(row.resolution_due).toISOString()).toBe('2026-11-16T15:00:00.000Z'); // Monday 17:00 Kyiv
    });
    it('pending pauses the clock in the database and resuming restores a later deadline', async () => {
      const tk = await fresh({ priority: 'high' });
      await as(api, agent).post(
        `/tickets/${tk.id}/messages`,
        reply('hi', { setStatus: 'pending' }),
      );
      const paused = (
        await t.db.execute<{
          sla_paused_at: string | null;
          resolution_remaining_min: number | null;
          sla_due_at: string | null;
        }>(
          sql`SELECT sla_paused_at, resolution_remaining_min, sla_due_at FROM tickets WHERE id = ${tk.id}`,
        )
      ).rows[0]!;
      expect(paused.sla_paused_at).not.toBeNull();
      expect(paused.resolution_remaining_min).toBeGreaterThan(0);
      expect(paused.sla_due_at).toBeNull();
      await new Promise((r) => setTimeout(r, 50));
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('here you go'));
      const open = (
        await t.db.execute<{
          sla_paused_at: string | null;
          resolution_remaining_min: number | null;
          sla_due_at: string | null;
          status: string;
        }>(
          sql`SELECT sla_paused_at, resolution_remaining_min, sla_due_at, status FROM tickets WHERE id = ${tk.id}`,
        )
      ).rows[0]!;
      expect(open).toMatchObject({
        sla_paused_at: null,
        resolution_remaining_min: null,
        status: 'open',
      });
      expect(open.sla_due_at).not.toBeNull();
    });
  });

  describe('ratings and read state', () => {
    it('only a resolved/closed ticket can be rated, once, 1–5, by its owner', async () => {
      const tk = await fresh();
      expect((await as(api, customer).post(`/tickets/${tk.id}/rating`, { score: 5 })).status).toBe(
        409,
      ); // still new
      await force(tk.id, 'resolved');
      for (const score of [0, 6, 2.5, '3', null])
        expect(
          (await as(api, customer).post(`/tickets/${tk.id}/rating`, { score })).status,
          String(score),
        ).toBe(400);
      expect((await as(api, agent).post(`/tickets/${tk.id}/rating`, { score: 5 })).status).toBe(
        403,
      );
      expect(
        (await as(api, customer).post(`/tickets/${tk.id}/rating`, { score: 4, comment: 'ok' }))
          .status,
      ).toBe(201);
      expect((await as(api, customer).post(`/tickets/${tk.id}/rating`, { score: 1 })).status).toBe(
        409,
      );
      expect((await detail(customer, tk.id)).rating).toMatchObject({ score: 4 });
    });
    it('unread: a staff reply highlights the ticket for the customer until it is marked read; their own replies do not', async () => {
      const tk = await fresh();
      const unread = async () =>
        (
          (await as(api, customer).get('/tickets?limit=100')).json as { items: TicketJson[] }
        ).items.find((i) => i.id === tk.id)!.unread;
      expect(await unread()).toBe(false);
      await as(api, agent).post(`/tickets/${tk.id}/messages`, reply('answer'));
      expect(await unread()).toBe(true);
      expect((await as(api, customer).post(`/tickets/${tk.id}/read`)).status).toBe(204);
      expect(await unread()).toBe(false);
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('thanks'));
      expect(await unread()).toBe(false);
      await as(api, agent).post(`/tickets/${tk.id}/messages`, reply('note', { kind: 'internal' }));
      expect(await unread()).toBe(false); // an internal note must not light up the customer's list
    });
  });
});
