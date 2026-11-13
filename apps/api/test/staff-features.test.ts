import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import {
  PASSWORDS,
  as,
  createExtraAgents,
  createTicketAs,
  createUsers,
  signIn,
  startApi,
  type Api,
  type Session,
  type TestUsers,
} from './harness';

type BulkResult = { results: Array<{ id: string; ok: boolean; reason?: string }> };

describe('bulk actions, templates, saved views, SLA settings', () => {
  let t: TestDb;
  let api: Api;
  let u: TestUsers;
  let customer: Session, customer2: Session, agent: Session, agent2: Session, lead: Session;
  beforeAll(async () => {
    t = await createTestDb();
    u = await createUsers(t.db);
    api = await startApi(t.url, {
      RATE_LIMIT_API_PER_MIN: '1000000',
      RATE_LIMIT_USER_PER_MIN: '1000000',
      LOGIN_IP_MAX_FAILURES: '10000',
      LOGIN_PAIR_MAX_FAILURES: '1000',
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
    await api.stop();
    await t.drop();
  });
  const bulk = (s: Session, ids: string[], operation: object) =>
    as(api, s).post('/tickets/bulk', { ids, operation });
  const results = (r: { json: unknown }) => (r.json as BulkResult).results;
  const state = async (id: string) =>
    (
      await t.db.execute<{
        status: string;
        priority: string;
        assignee_id: string | null;
        tags: string[];
        version: number;
      }>(sql`SELECT status, priority, assignee_id, tags, version FROM tickets WHERE id = ${id}`)
    ).rows[0]!;

  describe('bulk (acceptance #12)', () => {
    it('200 tickets with a mix of unavailable / invalid / fine ones: the fine ones are applied, every skipped one has a reason', async () => {
      const ids: string[] = [];
      const expectedOk = new Set<string>();
      const expectedReason = new Map<string, string>();
      for (let i = 0; i < 200; i += 1) {
        // the agent (payment) can see payment tickets; delivery ones are not theirs
        const mine = i % 4 !== 3;
        const tk = await createTicketAs(api, i % 2 ? customer : customer2, {
          category: mine ? 'payment' : 'delivery',
          subject: `bulk ${i}`,
        });
        ids.push(tk.id);
        if (!mine) expectedReason.set(tk.id, 'not_found_or_forbidden');
        else if (i % 8 === 0) {
          await t.db.execute(
            sql`UPDATE tickets SET status = 'closed', resolved_at = now(), closed_at = now() WHERE id = ${tk.id}`,
          );
          expectedReason.set(tk.id, 'closed');
        } else if (i % 8 === 1) {
          await t.db.execute(sql`UPDATE tickets SET priority = 'high' WHERE id = ${tk.id}`);
          expectedReason.set(tk.id, 'unchanged');
        } else expectedOk.add(tk.id);
      }
      const r = await bulk(agent, ids, { action: 'setPriority', priority: 'high' });
      expect(r.status).toBe(200);
      const res = results(r);
      expect(res.map((x) => x.id)).toEqual(ids); // same order as asked
      for (const x of res) {
        if (expectedOk.has(x.id)) expect(x, x.id).toEqual({ id: x.id, ok: true });
        else expect(x, x.id).toEqual({ id: x.id, ok: false, reason: expectedReason.get(x.id) });
      }
      expect(res.filter((x) => x.ok)).toHaveLength(expectedOk.size);
      for (const id of [...expectedOk].slice(0, 20))
        expect((await state(id)).priority).toBe('high');
      for (const [id, reason] of expectedReason)
        if (reason !== 'unchanged')
          expect((await state(id)).priority, `${id} (${reason}) untouched`).not.toBe('high');
    }, 120_000);

    it('limits: 0 ids, 201 ids, duplicates, non-uuids, unknown actions are 400', async () => {
      const id = (await createTicketAs(api, customer)).id;
      const op = { action: 'setPriority', priority: 'low' };
      expect((await bulk(lead, [], op)).status).toBe(400);
      expect(
        (
          await bulk(
            lead,
            Array.from({ length: 201 }, () => crypto.randomUUID()),
            op,
          )
        ).status,
      ).toBe(400);
      expect((await bulk(lead, [id, id], op)).status).toBe(400);
      expect((await bulk(lead, ['nope'], op)).status).toBe(400);
      expect((await bulk(lead, [id], { action: 'delete' })).status).toBe(400);
      expect(
        (await bulk(lead, [id], { action: 'setPriority', priority: 'urgent', extra: 1 })).status,
      ).toBe(400);
    });

    it('one ticket that breaks a rule (the 20-tag limit) is skipped with a reason: 200 with a full report, the others ARE applied — never a 400 after a partial change', async () => {
      const mk = async (n: number) => {
        const tk = await createTicketAs(api, customer, {
          category: 'payment',
          subject: `tags ${n}`,
        });
        if (n > 0) {
          const many = Array.from({ length: n }, (_, i) => `t${i}`);
          await t.db.execute(
            sql`UPDATE tickets SET tags = ${`{${many.join(',')}}`}::text[] WHERE id = ${tk.id}`,
          );
        }
        return tk.id;
      };
      const [b, a, c] = [await mk(0), await mk(19), await mk(0)] as [string, string, string];
      const r = await bulk(agent, [b, a, c], {
        action: 'setTags',
        mode: 'add',
        tags: ['x1', 'x2'],
      });
      expect(r.status).toBe(200);
      expect(results(r)).toEqual([
        { id: b, ok: true },
        { id: a, ok: false, reason: 'invalid_value' },
        { id: c, ok: true },
      ]);
      const tagsOf = async (id: string) =>
        (await t.db.execute<{ tags: string[] }>(sql`SELECT tags FROM tickets WHERE id = ${id}`))
          .rows[0]!.tags;
      expect(await tagsOf(b)).toEqual(['x1', 'x2']);
      expect(await tagsOf(a)).toHaveLength(19); // untouched
      expect(await tagsOf(c)).toEqual(['x1', 'x2']);
    });

    it('invalid status transitions are skipped with "invalid_transition", valid ones applied (per ticket)', async () => {
      const a = await createTicketAs(api, customer);
      const b = await createTicketAs(api, customer);
      await t.db.execute(
        sql`UPDATE tickets SET status = 'resolved', resolved_at = now(), first_responded_at = now() WHERE id = ${b.id}`,
      );
      const r = await bulk(lead, [a.id, b.id], { action: 'setStatus', status: 'pending' });
      expect(results(r)).toEqual([
        { id: a.id, ok: true },
        { id: b.id, ok: false, reason: 'invalid_transition' },
      ]);
      expect((await state(a.id)).status).toBe('pending');
      expect((await state(b.id)).status).toBe('resolved');
    });

    it('assign: the lead may assign anyone eligible; a customer/disabled user target is refused for ALL; an agent can only take free tickets', async () => {
      const a = await createTicketAs(api, customer);
      const b = await createTicketAs(api, customer);
      expect(
        results(await bulk(lead, [a.id, b.id], { action: 'assign', assigneeId: u.agent.id })).every(
          (x) => x.ok,
        ),
      ).toBe(true);
      for (const bad of [u.customer.id, u.disabled.id, crypto.randomUUID()]) {
        const r = results(await bulk(lead, [a.id], { action: 'assign', assigneeId: bad }));
        expect(r, bad).toEqual([{ id: a.id, ok: false, reason: 'assignee_not_eligible' }]);
      }
      expect((await state(a.id)).assignee_id).toBe(u.agent.id);
      // the agent cannot hand a ticket to a colleague, nor steal an assigned one
      const free = await createTicketAs(api, customer);
      expect(
        results(await bulk(agent, [free.id], { action: 'assign', assigneeId: u.agent2.id }))[0],
      ).toMatchObject({ ok: false, reason: 'not_found_or_forbidden' });
      expect(
        results(await bulk(agent, [free.id], { action: 'assign', assigneeId: u.agent.id }))[0],
      ).toEqual({ id: free.id, ok: true });
      const [other] = await createExtraAgents(t.db, 1, ['payment']);
      await t.db.execute(sql`UPDATE tickets SET assignee_id = ${other!.id} WHERE id = ${b.id}`);
      expect(
        results(await bulk(agent, [b.id], { action: 'assign', assigneeId: u.agent.id }))[0],
      ).toMatchObject({ ok: false });
      expect(results(await bulk(lead, [a.id], { action: 'assign', assigneeId: null }))[0]).toEqual({
        id: a.id,
        ok: true,
      });
    });

    it('tags: add / remove / replace', async () => {
      const a = await createTicketAs(api, customer);
      await bulk(lead, [a.id], { action: 'setTags', mode: 'add', tags: ['vip', 'bug'] });
      expect((await state(a.id)).tags.sort()).toEqual(['bug', 'vip']);
      await bulk(lead, [a.id], { action: 'setTags', mode: 'remove', tags: ['bug', 'nothere'] });
      expect((await state(a.id)).tags).toEqual(['vip']);
      await bulk(lead, [a.id], { action: 'setTags', mode: 'replace', tags: ['x', 'y'] });
      expect((await state(a.id)).tags.sort()).toEqual(['x', 'y']);
      expect(
        results(await bulk(lead, [a.id], { action: 'setTags', mode: 'add', tags: ['x'] }))[0],
      ).toMatchObject({ reason: 'unchanged' });
    });

    it('records history per ticket, bumps each version once, and a failure on one ticket does not touch the others', async () => {
      const a = await createTicketAs(api, customer);
      const b = await createTicketAs(api, customer, { category: 'delivery' });
      await bulk(agent, [b.id, a.id], { action: 'setPriority', priority: 'high' });
      expect((await state(a.id)).version).toBe(2);
      expect((await state(b.id)).version).toBe(1);
      expect(
        Number(
          (
            await t.db.execute<{ n: number }>(
              sql`SELECT count(*)::int n FROM ticket_events WHERE ticket_id = ${a.id} AND field = 'priority'`,
            )
          ).rows[0]?.n,
        ),
      ).toBe(1);
    });

    it('10 parallel bulk calls on the same tickets leave every ticket consistent (one version bump per real change)', async () => {
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => createTicketAs(api, customer)),
      ).then((x) => x.map((y) => y.id));
      await Promise.all(
        Array.from({ length: 10 }, () =>
          bulk(lead, ids, { action: 'setPriority', priority: 'urgent' }),
        ),
      );
      for (const id of ids)
        expect(await state(id)).toMatchObject({ priority: 'urgent', version: 2 });
    });
  });

  describe('canned responses', () => {
    it('lead: full CRUD; agents: read only; placeholders are validated', async () => {
      const made = await as(api, lead).post('/canned-responses', {
        title: 'Hi',
        body: 'Hello {{customer_name}}, about {{ticket_number}}',
        category: 'payment',
      });
      expect(made.status).toBe(201);
      const id = (made.json as { id: string }).id;
      expect(((await as(api, agent).get('/canned-responses')).json as unknown[]).length).toBe(1);
      const upd = await as(api, lead).put(`/canned-responses/${id}`, {
        title: 'Hi 2',
        body: 'Dear {{customer_name}}',
        category: null,
      });
      expect(upd.json).toMatchObject({ title: 'Hi 2', category: null });
      expect(
        (
          await as(api, lead).post('/canned-responses', {
            title: 'Bad',
            body: 'Your password is {{password}}',
          })
        ).status,
      ).toBe(400);
      for (const bad of [
        { title: '', body: 'x' },
        { title: 'x', body: '' },
        { title: 'x'.repeat(121), body: 'x' },
        { title: 'x', body: 'x', category: 'nope' },
        { title: 'x', body: 'x', extra: 1 },
      ]) {
        expect(
          (await as(api, lead).post('/canned-responses', bad)).status,
          JSON.stringify(bad).slice(0, 40),
        ).toBe(400);
      }
      expect(
        (
          await as(api, lead).put(`/canned-responses/${crypto.randomUUID()}`, {
            title: 'x',
            body: 'x',
          })
        ).status,
      ).toBe(404);
      expect((await as(api, lead).delete(`/canned-responses/${id}`)).status).toBe(204);
      expect((await as(api, lead).delete(`/canned-responses/${id}`)).status).toBe(404);
    });
  });

  describe('saved views', () => {
    it('are private to their owner; names are unique per user; delete only your own', async () => {
      const q = { status: ['open'], assignee: 'me' };
      const mine = await as(api, agent).post('/saved-views', { name: 'My open', query: q });
      expect(mine.status).toBe(201);
      expect(
        (await as(api, agent).post('/saved-views', { name: 'My open', query: q })).status,
      ).toBe(409);
      expect(
        (await as(api, agent2).post('/saved-views', { name: 'My open', query: q })).status,
      ).toBe(201); // other user, same name: fine
      expect(((await as(api, agent2).get('/saved-views')).json as unknown[]).length).toBe(1);
      const id = (mine.json as { id: string }).id;
      expect((await as(api, agent2).delete(`/saved-views/${id}`)).status).toBe(404);
      expect((await as(api, agent).delete(`/saved-views/${id}`)).status).toBe(204);
    });
    it('rejects malformed views', async () => {
      for (const bad of [
        { name: '', query: {} },
        { name: 'x', query: { cursor: 'abc' } },
        { name: 'x', query: { status: ['bogus'] } },
        { name: 'x'.repeat(61), query: {} },
        { name: 'x' },
      ]) {
        expect(
          (await as(api, agent).post('/saved-views', bad)).status,
          JSON.stringify(bad).slice(0, 50),
        ).toBe(400);
      }
    });
  });

  describe('SLA settings', () => {
    const policies = (
      over: Record<
        string,
        Partial<{ firstResponseMinutes: number; resolutionMinutes: number; businessHours: boolean }>
      > = {},
    ) =>
      (['urgent', 'high', 'normal', 'low'] as const).map((priority) => ({
        priority,
        firstResponseMinutes: 60,
        resolutionMinutes: 240,
        businessHours: priority !== 'urgent',
        ...(over[priority] ?? {}),
      }));
    it('everyone on staff can read them; only the lead can change them; new tickets use the new values', async () => {
      const before = (
        (await as(api, agent).get('/sla')).json as {
          policies: Array<{ priority: string; firstResponseMinutes: number }>;
        }
      ).policies;
      expect(before).toHaveLength(4);
      expect((await as(api, agent).put('/sla', { policies: policies() })).status).toBe(403);
      expect(
        (
          await as(api, lead).put('/sla', {
            policies: policies({ urgent: { firstResponseMinutes: 15, resolutionMinutes: 30 } }),
          })
        ).status,
      ).toBe(200);
      const tk = await createTicketAs(api, customer, { priority: 'high' });
      await as(api, lead).patch(`/tickets/${tk.id}`, { version: tk.version, priority: 'urgent' });
      const row = (
        await t.db.execute<{ created_at: string; first_response_due: string }>(
          sql`SELECT created_at, first_response_due FROM tickets WHERE id = ${tk.id}`,
        )
      ).rows[0]!;
      expect(new Date(row.first_response_due).getTime() - new Date(row.created_at).getTime()).toBe(
        15 * 60_000,
      );
    });
    it('rejects incomplete, duplicate, inverted or absurd settings and leaves the old ones in place', async () => {
      const bad = [
        { policies: policies().slice(0, 3) },
        { policies: [...policies().slice(0, 3), policies()[0]!] },
        { policies: policies({ high: { firstResponseMinutes: 0 } }) },
        { policies: policies({ high: { firstResponseMinutes: 500, resolutionMinutes: 100 } }) },
        { policies: policies({ low: { resolutionMinutes: 10_000_000 } }) },
        { policies: 'nope' },
        {},
      ];
      for (const b of bad)
        expect((await as(api, lead).put('/sla', b)).status, JSON.stringify(b).slice(0, 60)).toBe(
          400,
        );
      expect(
        Number(
          (
            await t.db.execute<{ n: number }>(
              sql`SELECT first_response_minutes n FROM sla_policies WHERE priority = 'urgent'`,
            )
          ).rows[0]?.n,
        ),
      ).toBe(15);
    });
  });

  describe('agents list', () => {
    it('lists active agents with their categories for the assignee picker (staff only)', async () => {
      const r = await as(api, lead).get('/agents');
      const list = r.json as Array<{ id: string; categories: string[] }>;
      expect(list.map((a) => a.id)).toContain(u.agent.id);
      expect(list.map((a) => a.id)).not.toContain(u.lead.id);
      expect(list.find((a) => a.id === u.agent.id)?.categories).toEqual(['payment']);
      expect((await as(api, customer).get('/agents')).status).toBe(403);
    });
  });
});
