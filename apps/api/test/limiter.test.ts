import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@helpdesk/db';
import { createTestDb, type TestDb } from '@helpdesk/db/testing';
import { sql } from 'drizzle-orm';
import { createLimiter } from '../src/lib/limiter';

describe('PostgreSQL rate limiter (real database)', () => {
  let t: TestDb;
  let limiter: ReturnType<typeof createLimiter>;
  beforeAll(async () => {
    t = await createTestDb();
    limiter = createLimiter(t.db);
  });
  afterAll(async () => t.drop());

  it('allows exactly `limit` hits per window, then refuses with a Retry-After', async () => {
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push(await limiter.hit('k:basic', 5, 60));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(results[4]).toMatchObject({ remaining: 0, count: 5 });
    expect(results[6]?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(results[6]?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('200 simultaneous hits against a quota of 50 → EXACTLY 50 allowed (atomic, no race overshoot)', async () => {
    const r = await Promise.all(Array.from({ length: 200 }, () => limiter.hit('k:race', 50, 60)));
    expect(r.filter((x) => x.allowed)).toHaveLength(50);
  });

  it('two independent connection pools (= two api replicas) share one quota', async () => {
    const other = createDb(t.url);
    try {
      const l2 = createLimiter(other.db);
      const r = await Promise.all(
        Array.from({ length: 100 }, (_, i) => (i % 2 ? limiter : l2).hit('k:replicas', 30, 60)),
      );
      expect(r.filter((x) => x.allowed)).toHaveLength(30);
    } finally {
      await other.close();
    }
  });

  it('keys are independent; a flooded key does not affect another', async () => {
    for (let i = 0; i < 20; i += 1) await limiter.hit('k:noisy', 3, 60);
    expect((await limiter.hit('k:quiet', 3, 60)).allowed).toBe(true);
  });

  it('the window rolls over', async () => {
    for (let i = 0; i < 3; i += 1) await limiter.hit('k:roll', 2, 1);
    expect((await limiter.hit('k:roll', 2, 1)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1_150));
    const after = await limiter.hit('k:roll', 2, 1);
    expect(after).toMatchObject({ allowed: true, count: 1 });
  });

  it('peek does not count; refund gives one back and never goes negative; reset clears', async () => {
    await limiter.hit('k:peek', 3, 60);
    await limiter.peek('k:peek', 3, 60);
    await limiter.peek('k:peek', 3, 60);
    expect((await limiter.peek('k:peek', 3, 60)).count).toBe(1);
    expect(await limiter.peek('k:never-seen', 3, 60)).toMatchObject({ count: 0, allowed: true });
    await limiter.refund('k:peek');
    await limiter.refund('k:peek');
    expect((await limiter.peek('k:peek', 3, 60)).count).toBe(0);
    await limiter.hit('k:reset', 3, 60);
    await limiter.reset('k:reset');
    expect((await limiter.peek('k:reset', 3, 60)).count).toBe(0);
  });

  it('hostile keys (quotes, unicode, 5 KB) are plain data, never SQL', async () => {
    for (const key of ["'; DROP TABLE rate_limits; --", 'ключ-🔑', 'x'.repeat(5_000), '']) {
      expect((await limiter.hit(key, 5, 60)).allowed).toBe(true);
    }
    expect(
      Number(
        (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM rate_limits`)).rows[0]
          ?.n,
      ),
    ).toBeGreaterThan(5);
  });

  it('purge removes only stale windows', async () => {
    await t.db.execute(
      sql`INSERT INTO rate_limits(key,count,window_start) VALUES ('old',1, now() - interval '2 hours'), ('fresh',1, now())`,
    );
    const removed = await limiter.purge(3_600);
    expect(removed).toBeGreaterThanOrEqual(1);
    const keys = (await t.db.execute<{ key: string }>(sql`SELECT key FROM rate_limits`)).rows.map(
      (r) => r.key,
    );
    expect(keys).toContain('fresh');
    expect(keys).not.toContain('old');
  });
});
