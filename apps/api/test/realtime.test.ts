import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  as,
  createTicketAs,
  createUsers,
  openEvents,
  reply,
  request,
  signIn,
  startApi,
  type Api,
  type Session,
  type TestUsers,
  type TicketJson,
} from './harness';

type Stream = Awaited<ReturnType<typeof openEvents>>;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const has = (s: Stream, type: string, pred: (d: Record<string, unknown>) => boolean = () => true) =>
  s.frames.some((f) => f.event === type && pred(f.data));

describe('realtime: SSE, presence, notifications (real server, real PostgreSQL)', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let customer: Session, customer2: Session, agent: Session, agent2: Session, lead: Session;
  const open: Stream[] = [];
  const stream = async (s: Session, o: Parameters<typeof openEvents>[2] = {}) => {
    const st = await openEvents(api, s, o);
    open.push(st);
    return st;
  };

  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '1000000',
      RATE_LIMIT_USER_PER_MIN: '1000000',
      LOGIN_IP_MAX_FAILURES: '10000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
      SSE_MAX_PER_USER: '3',
      SSE_MAX_PER_IP: '100',
      SSE_HEARTBEAT_MS: '300',
    });
    [customer, customer2, agent, agent2, lead] = await Promise.all([
      signIn(api, u.customer.email, PASSWORDS.customer),
      signIn(api, u.customer2.email, PASSWORDS.customer),
      signIn(api, u.agent.email, PASSWORDS.agent),
      signIn(api, u.agent2.email, PASSWORDS.agent),
      signIn(api, u.lead.email, PASSWORDS.lead),
    ]);
  });
  afterAll(async () => {
    open.forEach((s) => s.close());
    await api.stop();
    await t.drop();
  });

  describe('the stream', () => {
    it('needs a session; speaks text/event-stream; sends heartbeats', async () => {
      const anon = await request(api, { path: '/events' });
      expect(anon.status).toBe(401);
      const s = await stream(agent);
      expect(s.status).toBe(200);
      expect(s.headers['content-type']).toContain('text/event-stream');
      expect(s.headers['cache-control']).toContain('no-cache');
      await settle(700);
      expect(s.raw()).toContain(': connected');
      expect(s.raw()).toContain(': ping');
      s.close();
    });

    it('an event whose transaction COMMITS AFTER a later one (lower id, later commit) is still delivered — nothing is lost on out-of-order commits', async () => {
      const ag = await stream(agent);
      await settle(200);
      const tk = await createTicketAs(api, customer, {
        category: 'payment',
        subject: 'order test',
      });
      await ag.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id);
      const a = new pg.Client({ connectionString: t.url });
      const b = new pg.Client({ connectionString: t.url });
      await Promise.all([a.connect(), b.connect()]);
      const ins = (c: pg.Client, version: number) =>
        c.query(
          `INSERT INTO event_log (type, ticket_id, payload) VALUES ('ticket.changed', $1, $2::jsonb) RETURNING id`,
          [tk.id, JSON.stringify({ version, changed: ['status'] })],
        );
      try {
        await a.query('BEGIN');
        const first = await ins(a, 901); // takes the LOWER id, stays uncommitted
        await b.query('BEGIN');
        const second = await ins(b, 902);
        expect(Number(first.rows[0].id)).toBeLessThan(Number(second.rows[0].id));
        await b.query('COMMIT'); // the higher id becomes visible first and is delivered
        await ag.waitFor((f) => f.event === 'ticket.changed' && f.data.version === 902);
        await a.query('COMMIT'); // the lower id commits afterwards
        await ag.waitFor((f) => f.event === 'ticket.changed' && f.data.version === 901); // not lost
        const seen = ag.frames.filter(
          (f) => f.event === 'ticket.changed' && [901, 902].includes(Number(f.data.version)),
        );
        expect(seen).toHaveLength(2); // and delivered exactly once each
      } finally {
        await a.end().catch(() => undefined);
        await b.end().catch(() => undefined);
        ag.close();
      }
    });

    it('delivers new messages and ticket changes to everyone who may see the ticket — and only them', async () => {
      const [cust, cust2, ag, ag2, ld] = await Promise.all([
        stream(customer),
        stream(customer2),
        stream(agent),
        stream(agent2),
        stream(lead),
      ]);
      await settle(200);
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'rt test' });
      await ag.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id);
      await ld.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id);
      await cust.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id);

      const r = await as(api, agent).post(`/tickets/${tk.id}/messages`, reply('public answer'));
      const msgId = (r.json as { message: { id: string } }).message.id;
      for (const s of [cust, ag, ld])
        await s.waitFor((f) => f.event === 'message.created' && f.data.messageId === msgId);
      await settle(400);
      // not the other customer, not the agent of another category
      for (const s of [cust2, ag2])
        expect(
          s.frames.filter((f) => f.data.ticketId === tk.id),
          'stranger saw something',
        ).toEqual([]);
      [cust, cust2, ag, ag2, ld].forEach((s) => s.close());
    });

    it("INTERNAL notes: staff are told, the ticket's own customer is NOT (acceptance #4) — not even the message id", async () => {
      const cust = await stream(customer);
      const ag = await stream(agent);
      const tk = await createTicketAs(api, customer, {
        category: 'payment',
        subject: 'secret note rt',
      });
      await ag.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id);
      const note = await as(api, agent).post(
        `/tickets/${tk.id}/messages`,
        reply('INTERNAL ONLY', { kind: 'internal' }),
      );
      const noteId = (note.json as { message: { id: string } }).message.id;
      const pub = await as(api, agent).post(`/tickets/${tk.id}/messages`, reply('hello customer'));
      const pubId = (pub.json as { message: { id: string } }).message.id;
      await ag.waitFor(
        (f) =>
          f.event === 'message.created' &&
          f.data.messageId === noteId &&
          f.data.kind === 'internal',
      );
      await cust.waitFor((f) => f.event === 'message.created' && f.data.messageId === pubId); // proves the stream is alive and caught up
      expect(cust.raw()).not.toContain(noteId);
      expect(has(cust, 'message.created', (d) => d.kind === 'internal')).toBe(false);
      cust.close();
      ag.close();
    });

    it('a customer learns every new VERSION of their ticket but only the visible fields that changed (never tags, assignee or SLA)', async () => {
      const cust = await stream(customer);
      const lg = await stream(lead);
      const tk = await createTicketAs(api, customer, {
        category: 'payment',
        subject: 'staff only',
      });
      await lg.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id);
      let v = tk.version;
      const patch = async (body: object) => {
        const r = await as(api, lead).patch(`/tickets/${tk.id}`, { version: v, ...body });
        v = (r.json as { version: number }).version;
        return v;
      };
      const tagsV = await patch({ tags: ['vip'], assigneeId: u.agent.id });
      const priorityV = await patch({ priority: 'high', tags: ['vip', 'x'] });
      await lg.waitFor((f) => f.event === 'ticket.changed' && f.data.version === priorityV);
      await cust.waitFor((f) => f.event === 'ticket.changed' && f.data.version === priorityV);
      const mine = cust.frames.filter(
        (f) => f.event === 'ticket.changed' && f.data.ticketId === tk.id,
      );
      // BOTH changes reach the customer (their page must learn the new version), but only with the fields they can see
      expect(mine.map((f) => f.data.version)).toEqual([tagsV, priorityV]);
      expect(mine[0]!.data.changed).toEqual([]); // tags + assignee: nothing the customer can see
      expect(mine[1]!.data.changed).toEqual(['priority']);
      expect(cust.raw()).not.toMatch(/"tags"|"assignee"/);
      expect(tagsV).toBeLessThan(priorityV);
      // staff still see everything
      const staffSaw = lg.frames.filter(
        (f) => f.event === 'ticket.changed' && f.data.version === tagsV,
      );
      expect(staffSaw[0]!.data.changed).toEqual(expect.arrayContaining(['tags', 'assignee']));
      cust.close();
      lg.close();
    });

    it('notifications are personal: only the assignee is told, and the event names the ticket', async () => {
      const ag = await stream(agent);
      const lg = await stream(lead);
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'assign me' });
      await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        assigneeId: u.agent.id,
      });
      const f = await ag.waitFor(
        (x) => x.event === 'notification.created' && x.data.ticketId === tk.id,
      );
      expect(f.data).toMatchObject({ kind: 'assigned', number: `HD-${tk.number}` });
      await settle(300);
      expect(has(lg, 'notification.created')).toBe(false); // the lead did it themselves and is not the target
      ag.close();
      lg.close();
    });

    it('losing access to a ticket stops its events immediately (category moved away)', async () => {
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'moving' });
      const ag = await stream(agent);
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('one'));
      await ag.waitFor((f) => f.event === 'message.created' && f.data.ticketId === tk.id);
      const before = ag.frames.length;
      await as(api, lead).patch(`/tickets/${tk.id}`, { version: tk.version, category: 'delivery' });
      await ag
        .waitFor((f) => f.event === 'ticket.changed' && f.data.ticketId === tk.id)
        .catch(() => undefined); // the change itself may or may not still be visible
      const mark = ag.frames.length;
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('two, after the move'));
      await settle(500);
      expect(ag.frames.length, `events after losing access (had ${before}, then ${mark})`).toBe(
        mark,
      );
      ag.close();
    });

    it('event ids increase strictly and every frame is well-formed JSON of a known type', async () => {
      const ld = await stream(lead);
      const tk = await createTicketAs(api, customer, { subject: 'ordering' });
      for (let i = 0; i < 5; i += 1)
        await as(api, customer).post(`/tickets/${tk.id}/messages`, reply(`m${i}`));
      await ld.waitFor(
        (f) =>
          f.event === 'message.created' &&
          f.data.ticketId === tk.id &&
          f.data.messageId !== undefined,
      );
      await settle(400);
      const ids = ld.frames.map((f) => BigInt(f.id ?? '0'));
      for (let i = 1; i < ids.length; i += 1) expect(ids[i]! > ids[i - 1]!).toBe(true);
      expect(
        ld.frames.every((f) =>
          [
            'ticket.created',
            'ticket.changed',
            'message.created',
            'notification.created',
            'presence',
          ].includes(f.event),
        ),
      ).toBe(true);
      ld.close();
    });
  });

  describe('resume with Last-Event-ID', () => {
    it('a reconnecting client receives exactly what it missed — filtered by ITS permissions', async () => {
      const first = await stream(agent);
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'resume' });
      const other = await createTicketAs(api, customer, {
        category: 'delivery',
        subject: 'not for agent one',
      });
      const seen = await first.waitFor(
        (f) => f.event === 'ticket.created' && f.data.ticketId === tk.id,
      );
      first.close(); // connection lost
      const m1 = (
        await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('while you were away 1'))
      ).json as { message: { id: string } };
      await as(api, customer).post(
        `/tickets/${other.id}/messages`,
        reply('forbidden for agent one'),
      );
      const m2 = (
        await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('while you were away 2'))
      ).json as { message: { id: string } };
      const again = await stream(agent, { lastEventId: seen.id! });
      await again.waitFor(
        (f) => f.event === 'message.created' && f.data.messageId === m2.message.id,
      );
      expect(has(again, 'message.created', (d) => d.messageId === m1.message.id)).toBe(true);
      expect(again.frames.some((f) => f.data.ticketId === other.id)).toBe(false);
      expect(again.frames.every((f) => BigInt(f.id!) > BigInt(seen.id!))).toBe(true);
      again.close();
    });
    it('garbage Last-Event-ID values are ignored, not errors', async () => {
      for (const bad of [
        'abc',
        '-1',
        '1e9',
        '99999999999999999999999',
        "1'; DROP TABLE event_log;--",
        '',
      ]) {
        const s = await stream(lead, { lastEventId: bad });
        expect(s.status, bad).toBe(200);
        s.close();
      }
      expect((await request(api, { path: '/ready' })).status).toBe(200);
    });
    it('a customer replaying the log never receives internal-note events or foreign tickets', async () => {
      const mark = await stream(customer); // listening BEFORE the ticket exists, so it sees "ticket.created"
      const tk = await createTicketAs(api, customer, {
        category: 'payment',
        subject: 'replay note',
      });
      const m = await mark.waitFor(
        (f) => f.event === 'ticket.created' && f.data.ticketId === tk.id,
      );
      mark.close();
      const note = (
        await as(api, agent).post(
          `/tickets/${tk.id}/messages`,
          reply('hidden', { kind: 'internal' }),
        )
      ).json as { message: { id: string } };
      await createTicketAs(api, customer2, { subject: 'someone else' });
      const replay = await stream(customer, { lastEventId: String(BigInt(m.id!) - 1n) });
      await settle(600);
      expect(replay.raw()).not.toContain(note.message.id);
      expect(
        replay.frames.every((f) => f.event !== 'message.created' || f.data.kind === 'public'),
      ).toBe(true);
      expect(replay.frames.every((f) => f.data.ticketId === tk.id)).toBe(true); // nothing about the other customer's ticket
      replay.close();
    });
  });

  describe('limits and lifecycle', () => {
    it('at most SSE_MAX_PER_USER (3) streams per user: the 4th gets 429; closing one frees a slot; others are unaffected', async () => {
      const mine = await Promise.all([stream(customer2), stream(customer2), stream(customer2)]);
      const fourth = await request(api, {
        path: '/events',
        cookie: customer2.cookie,
        timeoutMs: 2000,
      });
      expect(fourth.status).toBe(429);
      expect((await stream(customer)).status).toBe(200);
      mine[0]!.close();
      await settle(300);
      const again = await stream(customer2);
      expect(again.status).toBe(200);
      [...mine, again].forEach((s) => s.close());
    });
    it('a stream ends by itself once its session is gone (logout) — it cannot outlive the login', async () => {
      const s2 = await signIn(api, u.agent2.email, PASSWORDS.agent);
      const st = await stream(s2);
      await settle(200);
      await request(api, { method: 'POST', path: '/auth/logout', cookie: s2.cookie });
      await Promise.race([
        st.ended,
        settle(3000).then(() => {
          throw new Error('stream still open after logout');
        }),
      ]);
    });
    it("logout closes ITS streams at once (not at the next heartbeat) and leaves the same user's other session streaming", async () => {
      const own = await startApi(t.url, { SSE_HEARTBEAT_MS: '60000' });
      try {
        const a1 = await signIn(own, u.agent2.email, PASSWORDS.agent);
        const a2 = await signIn(own, u.agent2.email, PASSWORDS.agent);
        const [s1, s2] = await Promise.all([openEvents(own, a1), openEvents(own, a2)]);
        await settle(200);
        const started = Date.now();
        await request(own, { method: 'POST', path: '/auth/logout', cookie: a1.cookie });
        await Promise.race([
          s1.ended,
          settle(2000).then(() => {
            throw new Error('stream still open after logout');
          }),
        ]);
        expect(Date.now() - started).toBeLessThan(1500);
        await settle(300);
        expect(own.logs()).not.toContain('"level":"error"');
        s2.close();
      } finally {
        await own.stop();
      }
    });
    it('on SIGTERM open streams are closed and the server exits 0 promptly (they must not block shutdown)', async () => {
      const own = await startApi(t.url, { SHUTDOWN_TIMEOUT_MS: '8000' });
      const a = await signIn(own, u.agent.email, PASSWORDS.agent);
      const l = await signIn(own, u.lead.email, PASSWORDS.lead);
      const streams = await Promise.all([openEvents(own, a), openEvents(own, l)]);
      const started = Date.now();
      const code = await own.stop('SIGTERM');
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(4000);
      await Promise.all(streams.map((s) => s.ended));
    });
    it('the stream recovers after the database drops its LISTEN connection: new events still arrive', async () => {
      const ag = await stream(lead);
      await t.db.execute(
        sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN%' AND datname = current_database()`,
      );
      await settle(1800);
      const tk = await createTicketAs(api, customer, { subject: 'after listen drop' });
      await ag.waitFor((f) => f.event === 'ticket.created' && f.data.ticketId === tk.id, 8000);
      ag.close();
    });
  });

  describe('presence ("Ivan is replying")', () => {
    it('staff on the ticket see who is typing; customers neither see nor can set it', async () => {
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'typing' });
      const ld = await stream(lead);
      const cust = await stream(customer);
      expect((await as(api, agent).post(`/tickets/${tk.id}/typing`, { typing: true })).status).toBe(
        204,
      );
      const f = await ld.waitFor((x) => x.event === 'presence' && x.data.ticketId === tk.id);
      expect(f.data).toMatchObject({ userId: u.agent.id, name: 'Agent One', typing: true });
      const list = (await as(api, lead).get(`/tickets/${tk.id}/presence`)).json as Array<{
        name: string;
      }>;
      expect(list.map((x) => x.name)).toEqual(['Agent One']);
      expect(
        ((await as(api, agent).get(`/tickets/${tk.id}/presence`)).json as unknown[]).length,
      ).toBe(0); // not yourself
      await as(api, agent).post(`/tickets/${tk.id}/typing`, { typing: false });
      await ld.waitFor((x) => x.event === 'presence' && x.data.typing === false);
      expect(
        ((await as(api, lead).get(`/tickets/${tk.id}/presence`)).json as unknown[]).length,
      ).toBe(0);
      await settle(300);
      expect(has(cust, 'presence')).toBe(false);
      expect(
        (await as(api, customer).post(`/tickets/${tk.id}/typing`, { typing: true })).status,
      ).toBe(403);
      expect((await as(api, customer).get(`/tickets/${tk.id}/presence`)).status).toBe(403);
      ld.close();
      cust.close();
    });
    it('presence expires on its own (a closed browser tab stops "typing" within seconds)', async () => {
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'expire' });
      await as(api, agent).post(`/tickets/${tk.id}/typing`, { typing: true });
      await t.db.execute(
        sql`UPDATE ticket_presence SET expires_at = now() - interval '1 second' WHERE ticket_id = ${tk.id}`,
      );
      expect(
        ((await as(api, lead).get(`/tickets/${tk.id}/presence`)).json as unknown[]).length,
      ).toBe(0);
    });
    it('an agent cannot announce typing on, or read presence of, a ticket they cannot see; bad bodies are 400', async () => {
      const tk = await createTicketAs(api, customer, { category: 'delivery', subject: 'not mine' });
      expect((await as(api, agent).post(`/tickets/${tk.id}/typing`, { typing: true })).status).toBe(
        404,
      );
      expect((await as(api, agent).get(`/tickets/${tk.id}/presence`)).status).toBe(404);
      for (const bad of [{}, { typing: 'yes' }, { typing: true, extra: 1 }])
        expect((await as(api, lead).post(`/tickets/${tk.id}/typing`, bad)).status).toBe(400);
    });
  });

  describe('notifications API', () => {
    it("lists my notifications, counts unread, marks read; I cannot touch anyone else's", async () => {
      const tk = await createTicketAs(api, customer, { category: 'payment', subject: 'notify me' });
      await as(api, lead).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        assigneeId: u.agent.id,
      });
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('customer replied'));
      const list = (await as(api, agent).get('/notifications')).json as {
        items: Array<{
          id: string;
          type: string;
          ticket: { code: string; subject: string };
          readAt: string | null;
        }>;
        unreadCount: number;
      };
      const mine = list.items.filter((n) => n.ticket.subject === 'notify me');
      expect(mine.map((n) => n.type).sort()).toEqual(['assigned', 'customer_replied']);
      expect(mine[0]?.ticket.code).toBe(`HD-${tk.number}`);
      expect(list.unreadCount).toBeGreaterThanOrEqual(2);
      // another agent cannot read or mark them
      const theirs = (await as(api, agent2).get('/notifications')).json as { items: unknown[] };
      expect(theirs.items).toEqual([]);
      expect(
        (
          (await as(api, agent2).post('/notifications/read', { ids: mine.map((n) => n.id) }))
            .json as { marked: number }
        ).marked,
      ).toBe(0);
      expect(
        ((await as(api, agent).get('/notifications')).json as { unreadCount: number }).unreadCount,
      ).toBe(list.unreadCount);
      // mine can
      expect(
        (
          (await as(api, agent).post('/notifications/read', { ids: mine.map((n) => n.id) }))
            .json as { marked: number }
        ).marked,
      ).toBe(2);
      expect(
        ((await as(api, agent).get('/notifications')).json as { unreadCount: number }).unreadCount,
      ).toBe(list.unreadCount - 2);
      expect(
        (
          (await as(api, agent).post('/notifications/read', { ids: mine.map((n) => n.id) }))
            .json as { marked: number }
        ).marked,
      ).toBe(0); // idempotent
    });
    it('a notification about a ticket the user can no longer see is hidden (its subject must not leak)', async () => {
      const tk = await createTicketAs(api, customer, {
        category: 'payment',
        subject: 'about to move away',
      });
      await as(api, agent).patch(`/tickets/${tk.id}`, {
        version: tk.version,
        assigneeId: u.agent.id,
      });
      await as(api, customer).post(`/tickets/${tk.id}/messages`, reply('ping'));
      expect(JSON.stringify((await as(api, agent).get('/notifications')).json)).toContain(
        'about to move away',
      );
      const v = ((await as(api, lead).get(`/tickets/${tk.id}`)).json as { ticket: TicketJson })
        .ticket.version;
      await as(api, lead).patch(`/tickets/${tk.id}`, { version: v, assigneeId: null });
      await as(api, lead).patch(`/tickets/${tk.id}`, { version: v + 1, category: 'delivery' });
      expect(JSON.stringify((await as(api, agent).get('/notifications')).json)).not.toContain(
        'about to move away',
      );
    });
    it('customers have no notification endpoints; bad bodies are 400', async () => {
      expect((await as(api, customer).get('/notifications')).status).toBe(403);
      expect(
        (await as(api, customer).post('/notifications/read', { ids: [crypto.randomUUID()] }))
          .status,
      ).toBe(403);
      for (const bad of [
        {},
        { ids: [] },
        { ids: ['nope'] },
        { ids: Array.from({ length: 201 }, () => crypto.randomUUID()) },
        { ids: [crypto.randomUUID()], x: 1 },
      ]) {
        expect(
          (await as(api, agent).post('/notifications/read', bad)).status,
          JSON.stringify(bad).slice(0, 40),
        ).toBe(400);
      }
    });
  });
});
