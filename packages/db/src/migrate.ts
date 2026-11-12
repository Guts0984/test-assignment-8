import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { DbHandle } from './client';
import { ensureReferenceData } from './reference';

/** Arbitrary constant: all instances serialise schema changes on this advisory lock. */
const MIGRATION_LOCK_ID = 7_351_902_114;

export const defaultMigrationsFolder = (): string => path.resolve(__dirname, '..', 'drizzle');

/**
 * Applies pending migrations and seeds reference data. Safe to call concurrently from several
 * processes (e.g. two api replicas booting): the advisory lock makes the second one wait, then no-op.
 */
export const migrate = async (
  handle: DbHandle,
  migrationsFolder = defaultMigrationsFolder(),
): Promise<void> => {
  const client = await handle.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await drizzleMigrate(handle.db, { migrationsFolder });
      await ensureReferenceData(handle.db);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
};

export const dbIsReachable = async (handle: DbHandle): Promise<boolean> => {
  try {
    await handle.db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
};
