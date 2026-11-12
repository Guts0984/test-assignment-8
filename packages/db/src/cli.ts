#!/usr/bin/env node
import { createDb } from './client';
import { migrate } from './migrate';
import { resetDatabase } from './reset';
import { seed } from './seed';

const usage =
  'usage: helpdesk-db <migrate|seed|setup|reset>   (setup = migrate + seed; reset = DROP ALL + migrate, dev only)';

/** Optional positive integer env var: undefined when unset, NaN (and an error message) when invalid. */
const positiveInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a positive integer, got "${raw}"`);
    return Number.NaN;
  }
  return n;
};

const main = async (): Promise<number> => {
  const command = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  if (!['migrate', 'seed', 'setup', 'reset'].includes(command ?? '')) {
    console.error(usage);
    return 2;
  }
  const sizes = {
    tickets: positiveInt('SEED_TICKETS'),
    customers: positiveInt('SEED_CUSTOMERS'),
  };
  if (Number.isNaN(sizes.tickets) || Number.isNaN(sizes.customers)) return 2;
  const handle = createDb(url);
  try {
    if (command === 'reset') {
      await resetDatabase(handle);
      console.log('database reset and migrated');
      return 0;
    }
    if (command === 'migrate' || command === 'setup') {
      await migrate(handle);
      console.log('migrations applied');
    }
    if (command === 'seed' || command === 'setup') {
      const started = Date.now();
      const result = await seed(handle, {
        ...(sizes.tickets ? { tickets: sizes.tickets } : {}),
        ...(sizes.customers ? { customers: sizes.customers } : {}),
      });
      console.log(
        result.skipped
          ? 'seed skipped: database already has data'
          : `seeded ${result.users} users, ${result.tickets} tickets, ${result.messages} messages in ${Date.now() - started} ms`,
      );
    }
    return 0;
  } finally {
    await handle.close();
  }
};

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
