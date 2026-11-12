import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CATEGORIES, DEFAULT_SLA_POLICIES, PRIORITIES } from '@helpdesk/shared';
import { createDb, migrate, slaPolicies, TICKET_COUNTER } from '../src';
import { createTestDb, type TestDb } from '../src/testing';
import { rows } from './helpers';

describe('migrations', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb({ migrate: false });
  });
  afterAll(async () => t.drop());

  it('two processes migrating a blank database at the same moment both succeed (advisory lock)', async () => {
    const a = createDb(t.url);
    const b = createDb(t.url);
    try {
      const results = await Promise.allSettled([migrate(a), migrate(b), migrate(a), migrate(b)]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('is idempotent: re-running changes nothing and keeps lead-edited SLA rows', async () => {
    await t.db
      .update(slaPolicies)
      .set({ firstResponseMinutes: 7 })
      .where(sql`priority = 'normal'`);
    await migrate(t);
    const [normal] = await t.db
      .select()
      .from(slaPolicies)
      .where(sql`priority = 'normal'`);
    expect(normal?.firstResponseMinutes).toBe(7);
    const [{ n }] = (await rows<{ n: number }>(
      t.db,
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('creates reference data: categories, 4 SLA policies matching the defaults, the ticket counter', async () => {
    const cats = await rows<{ slug: string }>(
      t.db,
      sql`SELECT slug FROM categories ORDER BY sort_order`,
    );
    expect(cats.map((c) => c.slug)).toEqual([...CATEGORIES]);
    const pol = await rows<{ priority: string; business_hours: boolean }>(
      t.db,
      sql`SELECT * FROM sla_policies`,
    );
    expect(pol.map((p) => p.priority).sort()).toEqual([...PRIORITIES].sort());
    expect(pol.find((p) => p.priority === 'urgent')?.business_hours).toBe(
      DEFAULT_SLA_POLICIES.urgent.businessHours,
    );
    const c = await rows<{ value: string }>(
      t.db,
      sql`SELECT value FROM counters WHERE name = ${TICKET_COUNTER}`,
    );
    expect(Number(c[0]?.value)).toBe(1000);
  });

  it('all the indexes the README promises exist', async () => {
    const idx = (
      await rows<{ indexname: string }>(
        t.db,
        sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
      )
    ).map((r) => r.indexname);
    for (const name of [
      'tickets_queue_idx',
      'tickets_assignee_status_idx',
      'tickets_customer_idx',
      'tickets_created_idx',
      'tickets_updated_idx',
      'tickets_sla_due_idx',
      'tickets_breached_idx',
      'tickets_tags_gin',
      'tickets_search_gin',
      'messages_search_gin',
      'messages_ticket_idx',
      'messages_author_client_uq',
      'tickets_number_uq',
      'jobs_due_idx',
      'jobs_dedupe_uq',
      'attachments_orphans_idx',
      'users_email_uq',
    ])
      expect(idx, name).toContain(name);
  });

  it('refuses to start against a migration folder that does not exist (fails loudly, not silently)', async () => {
    await expect(migrate(t, '/nonexistent/folder')).rejects.toThrow();
  });
});
