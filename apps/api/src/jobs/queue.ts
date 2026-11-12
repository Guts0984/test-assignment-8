import { sql } from 'drizzle-orm';
import type { Queryable } from '../tickets/db';

export type Job = {
  id: number;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
};

/**
 * Job queue on PostgreSQL. Nothing lives in memory, so a restart loses nothing; the lease + SKIP LOCKED
 * claim means two workers (or two api instances) never run the same job at the same time.
 */
export const enqueue = async (
  db: Queryable,
  j: {
    type: string;
    payload?: unknown;
    delaySeconds?: number;
    dedupeKey?: string;
    maxAttempts?: number;
  },
): Promise<number | null> => {
  const r = await db.execute<{ id: number }>(sql`
    INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts)
    VALUES (${j.type}, ${JSON.stringify(j.payload ?? {})}::jsonb, now() + make_interval(secs => ${j.delaySeconds ?? 0}), ${j.dedupeKey ?? null}, ${j.maxAttempts ?? 5})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
    RETURNING id`);
  return r.rows[0]?.id ?? null;
};

/** Takes the oldest due job, or null. The lease (`locked_until`) is what a crashed worker leaves behind. */
export const claim = async (
  db: Queryable,
  workerId: string,
  leaseSeconds: number,
): Promise<Job | null> => {
  const r = await db.execute<Job>(sql`
    UPDATE jobs SET status = 'running', locked_by = ${workerId}, locked_until = now() + make_interval(secs => ${leaseSeconds}), attempts = attempts + 1
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, type, payload, attempts, max_attempts`);
  return r.rows[0] ?? null;
};

/** A worker died mid-job: its lease ran out. The job goes back to the queue (or fails for good after max attempts). */
export const reclaimExpired = async (db: Queryable): Promise<number> => {
  const r = await db.execute(sql`
    UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'queued'::job_status END,
                    locked_by = NULL, locked_until = NULL,
                    last_error = COALESCE(last_error, 'lease expired (worker crashed?)'),
                    finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
    WHERE status = 'running' AND locked_until < now()`);
  return r.rowCount ?? 0;
};

export const complete = async (db: Queryable, id: number): Promise<void> => {
  await db.execute(
    sql`UPDATE jobs SET status = 'done', finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = ${id}`,
  );
};

/** Retry with exponential backoff, or give up after max_attempts. */
export const fail = async (db: Queryable, job: Job, error: unknown): Promise<void> => {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const backoff = Math.min(300, 2 ** job.attempts * 5);
  await db.execute(sql`
    UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'queued'::job_status END,
                    run_at = now() + make_interval(secs => ${backoff}), last_error = ${message},
                    finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
                    locked_by = NULL, locked_until = NULL
    WHERE id = ${job.id}`);
};
