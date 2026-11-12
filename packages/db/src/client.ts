import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type DbHandle = {
  readonly db: Db;
  readonly pool: Pool;
  readonly close: () => Promise<void>;
};

export const createDb = (
  connectionString: string,
  options: Omit<PoolConfig, 'connectionString'> = {},
): DbHandle => {
  const pool = new Pool({ connectionString, max: 10, ...options });
  // An idle client erroring (e.g. server restart) must not crash the process.
  pool.on('error', () => undefined);
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
};
