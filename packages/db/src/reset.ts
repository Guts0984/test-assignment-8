import { sql } from 'drizzle-orm';
import type { DbHandle } from './client';
import { migrate } from './migrate';

/**
 * Drops EVERYTHING (public + drizzle schemas) and re-applies migrations. Development/test only.
 * Refuses to run when NODE_ENV=production.
 */
export const resetDatabase = async (handle: DbHandle): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to reset a database when NODE_ENV=production');
  }
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  await migrate(handle);
};
