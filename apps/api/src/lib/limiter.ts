import type { Db } from '@helpdesk/db';
import { sql } from 'drizzle-orm';

export type HitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  /** seconds until the window resets (≥ 1) */
  retryAfterSeconds: number;
};

type Row = { count: number; reset_in: number };

const toResult = (row: Row | undefined, limit: number): HitResult => {
  const count = Number(row?.count ?? 0);
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(Number(row?.reset_in ?? 1))),
  };
};

/**
 * Fixed-window counters in the `rate_limits` table. One atomic INSERT … ON CONFLICT per hit, so
 * concurrent requests (and several api instances) can never exceed the quota by racing.
 */
export const createLimiter = (db: Pick<Db, 'execute'>) => ({
  /** Counts one event and tells whether it is within `limit` per `windowSeconds`. */
  hit: async (key: string, limit: number, windowSeconds: number): Promise<HitResult> => {
    const res = await db.execute<Row>(sql`
      INSERT INTO rate_limits AS r (key, count, window_start)
      VALUES (${key}, 1, now())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN r.window_start <= now() - make_interval(secs => ${windowSeconds}) THEN 1 ELSE r.count + 1 END,
        window_start = CASE WHEN r.window_start <= now() - make_interval(secs => ${windowSeconds}) THEN now() ELSE r.window_start END
      RETURNING count, EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSeconds}) - now()))::float8 AS reset_in`);
    return toResult(res.rows[0], limit);
  },

  /** Current count without counting (is this key already over `limit`?). */
  peek: async (key: string, limit: number, windowSeconds: number): Promise<HitResult> => {
    const res = await db.execute<Row>(sql`
      SELECT count, EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSeconds}) - now()))::float8 AS reset_in
      FROM rate_limits
      WHERE key = ${key} AND window_start > now() - make_interval(secs => ${windowSeconds})`);
    const row = res.rows[0];
    return row
      ? toResult(row, limit)
      : { allowed: true, count: 0, limit, remaining: limit, retryAfterSeconds: 1 };
  },

  /** Gives back one counted event (used when a reserved login attempt turns out to succeed). */
  refund: async (key: string): Promise<void> => {
    await db.execute(sql`UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE key = ${key}`);
  },

  reset: async (key: string): Promise<void> => {
    await db.execute(sql`DELETE FROM rate_limits WHERE key = ${key}`);
  },

  /** Deletes stale windows. Returns the number of rows removed. */
  purge: async (olderThanSeconds = 3_600): Promise<number> => {
    const res = await db.execute(
      sql`DELETE FROM rate_limits WHERE window_start < now() - make_interval(secs => ${olderThanSeconds})`,
    );
    return res.rowCount ?? 0;
  },
});

export type Limiter = ReturnType<typeof createLimiter>;
