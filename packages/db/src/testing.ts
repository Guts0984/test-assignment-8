import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createDb, type DbHandle } from './client';
import { migrate } from './migrate';

/**
 * Admin connection (can CREATE DATABASE). In docker-compose.db.yml this is the `postgres` service
 * published on localhost.
 */
export const adminUrl = (): string =>
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgres://helpdesk:helpdesk_dev_password@localhost:5440/postgres';

const withDatabase = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

export type TestDb = DbHandle & {
  readonly url: string;
  readonly name: string;
  readonly drop: () => Promise<void>;
};

/** Creates a fresh, migrated database with a random name — each test file gets full isolation. */
export const createTestDb = async (options: { migrate?: boolean } = {}): Promise<TestDb> => {
  const name = `hd_test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl(), max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl(), name);
  const handle = createDb(url);
  if (options.migrate !== false) await migrate(handle);
  const drop = async () => {
    await handle.close();
    const a = new Pool({ connectionString: adminUrl(), max: 1 });
    try {
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await a.end();
    }
  };
  return { ...handle, url, name, drop };
};
