#!/usr/bin/env node
import { createDb } from './client';
import { migrate } from './migrate';
import { seed } from './seed';

const usage = 'usage: helpdesk-db <migrate|seed|setup>   (setup = migrate + seed)';

const main = async (): Promise<number> => {
  const command = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  if (command !== 'migrate' && command !== 'seed' && command !== 'setup') {
    console.error(usage);
    return 2;
  }
  const handle = createDb(url);
  try {
    if (command === 'migrate' || command === 'setup') {
      await migrate(handle);
      console.log('migrations applied');
    }
    if (command === 'seed' || command === 'setup') {
      const started = Date.now();
      const result = await seed(handle);
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
