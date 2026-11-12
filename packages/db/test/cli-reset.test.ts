import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { resetDatabase, seed } from '../src';
import { createTestDb, type TestDb } from '../src/testing';
import { makeTicket, makeUser, pgCode } from './helpers';

const run = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { env: { PATH: process.env.PATH ?? '', ...env }, cwd: process.cwd() },
      (error, stdout, stderr) =>
        resolve({
          code: error ? Number((error as { code?: number }).code ?? 1) : 0,
          out: stdout + stderr,
        }),
    );
  });

describe('CLI (what the Docker container runs)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb({ migrate: false });
  });
  afterAll(async () => t.drop());
  const count = async (table: string) =>
    Number(
      (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM ${sql.raw(table)}`))
        .rows[0]?.n,
    );

  it('refuses to run without DATABASE_URL, with an unknown command, or with a bad SEED_TICKETS', async () => {
    expect((await run(['setup'], {})).code).toBe(2);
    expect((await run(['explode'], { DATABASE_URL: t.url })).code).toBe(2);
    for (const bad of ['abc', '0', '-5', '1.5']) {
      const r = await run(['seed'], { DATABASE_URL: t.url, SEED_TICKETS: bad });
      expect(r.code, bad).toBe(2);
      expect(r.out).toContain('SEED_TICKETS');
    }
  });

  it('setup honours SEED_TICKETS / SEED_CUSTOMERS and a second run is a no-op', async () => {
    const env = { DATABASE_URL: t.url, SEED_TICKETS: '37', SEED_CUSTOMERS: '9' };
    const first = await run(['setup'], env);
    expect(first.code, first.out).toBe(0);
    expect(await count('tickets')).toBe(37);
    expect(await count('users')).toBe(9 + 6 + 1);
    const second = await run(['setup'], env);
    expect(second.out).toContain('seed skipped');
    expect(await count('tickets')).toBe(37);
  });

  it('reset is refused in production and leaves the data alone', async () => {
    const r = await run(['reset'], { DATABASE_URL: t.url, NODE_ENV: 'production' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('refusing');
    expect(await count('tickets')).toBe(37);
  });

  it('reset wipes everything and re-applies migrations + reference data (API: resetDatabase)', async () => {
    await resetDatabase(t);
    expect(await count('tickets')).toBe(0);
    expect(await count('users')).toBe(0);
    expect(await count('categories')).toBe(5);
    expect(await count('sla_policies')).toBe(4);
    expect(
      Number(
        (await t.db.execute<{ value: string }>(sql`SELECT value FROM counters`)).rows[0]?.value,
      ),
    ).toBe(1000);
    // and it is seedable again
    expect(
      (await seed(t, { tickets: 20, customers: 3, hashPassword: async () => '$argon2id$x' }))
        .skipped,
    ).toBe(false);
  });
});

describe('what PostgreSQL does with hostile text (the API layer must stop these first)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t.drop());

  it('a NUL byte is a DB error (22021) — so validation MUST reject it before it reaches SQL (otherwise: 5xx)', async () => {
    const c = await makeUser(t.db);
    expect(await pgCode(makeTicket(t.db, c.id, { subject: 'a\u0000b' }))).toBe('22021');
  });
  it('quotes, SQL fragments, emoji and RTL text are stored verbatim (parameterised queries)', async () => {
    const c = await makeUser(t.db);
    const nasty = `'; DROP TABLE tickets; -- "quoted" \\ 😀 ‮evil`;
    const tk = await makeTicket(t.db, c.id, { subject: nasty.slice(0, 100) });
    const [row] = (
      await t.db.execute<{ subject: string }>(sql`SELECT subject FROM tickets WHERE id = ${tk.id}`)
    ).rows;
    expect(row?.subject).toBe(nasty.slice(0, 100));
    expect(
      Number(
        (await t.db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM tickets`)).rows[0]?.n,
      ),
    ).toBeGreaterThan(0);
  });
  it('full-text search does not throw on tsquery metacharacters when plainto_tsquery is used', async () => {
    for (const q of ["'", '&', '!', ':*', '(', '))((', '<->', '\\', 'a & | b', '   ']) {
      expect(
        await pgCode(
          t.db.execute(
            sql`SELECT count(*) FROM tickets WHERE search @@ plainto_tsquery('simple', ${q})`,
          ),
        ),
        q,
      ).toBe('OK');
    }
  });
  it('...but raw to_tsquery DOES throw on the same input — the API must never use it on user text', async () => {
    expect(await pgCode(t.db.execute(sql`SELECT to_tsquery('simple', ${'a & | b'})`))).toBe(
      '42601',
    );
  });
});
