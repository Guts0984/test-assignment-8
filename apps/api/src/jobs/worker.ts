import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { JobContext } from './handlers';
import { RECURRING } from './handlers';
import { claim, complete, enqueue, fail, reclaimExpired } from './queue';

/** Makes sure each recurring job has exactly one queued/running instance (safe to call on every boot, from every replica). */
export const scheduleRecurring = async (ctx: Pick<JobContext, 'db'>): Promise<void> => {
  for (const type of Object.keys(RECURRING))
    await enqueue(ctx.db, { type, dedupeKey: `recurring:${type}`, maxAttempts: 1_000_000 });
};

export const startWorker = (ctx: JobContext, opts: { pollMs: number; leaseSeconds: number }) => {
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const runOne = async (): Promise<boolean> => {
    const job = await claim(ctx.db, workerId, opts.leaseSeconds);
    if (!job) return false;
    const recurring = RECURRING[job.type];
    try {
      if (!recurring) throw new Error(`unknown job type "${job.type}"`);
      const result = await recurring.handler(ctx);
      // finish AND schedule the next run atomically: no gap where the chain could be lost, no double chain
      await ctx.db.transaction(async (tx) => {
        await complete(tx, job.id);
        await enqueue(tx, {
          type: job.type,
          delaySeconds: recurring.everySeconds,
          dedupeKey: `recurring:${job.type}`,
          maxAttempts: 1_000_000,
        });
      });
      ctx.logger.debug('job done', { type: job.type, result });
    } catch (err) {
      ctx.logger.warn('job failed', {
        type: job.type,
        attempt: job.attempts,
        err: err instanceof Error ? err.message : String(err),
      });
      await fail(ctx.db, job, err);
    }
    return true;
  };

  const tick = async (): Promise<void> => {
    try {
      await reclaimExpired(ctx.db);
      while (!stopped && (await runOne())) {
        /* drain everything that is due */
      }
    } catch (err) {
      ctx.logger.warn('worker tick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const loop = (): void => {
    if (stopped) return;
    running = tick().then(() => {
      if (!stopped) timer = setTimeout(loop, opts.pollMs);
    });
  };
  void scheduleRecurring(ctx).then(loop, (err: unknown) => {
    ctx.logger.warn('could not schedule jobs', { err: String(err) });
    timer = setTimeout(loop, opts.pollMs);
  });

  return {
    /** Stops polling and waits for the job in progress to finish (graceful shutdown). */
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
};

export const pendingJobs = async (ctx: Pick<JobContext, 'db'>): Promise<number> =>
  Number(
    (
      await ctx.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM jobs WHERE status IN ('queued','running')`,
      )
    ).rows[0]?.n ?? 0,
  );
