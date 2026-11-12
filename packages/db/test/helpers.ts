import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../src';
import { tickets, users } from '../src';

/** Extracts the SQLSTATE from a pg / drizzle error (drizzle wraps pg errors in `cause`). */
export const pgCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    let e: unknown = error;
    for (let i = 0; i < 5 && e; i += 1) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
      e = (e as { cause?: unknown }).cause;
    }
    throw error;
  }
  return 'OK';
};

export const SQLSTATE = {
  ok: 'OK',
  unique: '23505',
  fk: '23503',
  check: '23514',
  notNull: '23502',
  badEnum: '22P02',
  generatedWrite: '428C9',
} as const;

let counter = 0;
export const makeUser = async (
  db: Db,
  role: 'customer' | 'agent' | 'lead' = 'customer',
  overrides: Partial<typeof users.$inferInsert> = {},
) => {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `u${counter}-${randomUUID().slice(0, 8)}@t.test`,
      name: `User ${counter}`,
      role,
      passwordHash: 'x',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('user insert failed');
  return row;
};

export const makeTicket = async (
  db: Db,
  customerId: string,
  overrides: Partial<typeof tickets.$inferInsert> = {},
) => {
  counter += 1;
  const created = overrides.createdAt ?? new Date();
  const [row] = await db
    .insert(tickets)
    .values({
      number: 100_000 + counter + Math.floor(Math.random() * 1_000_000),
      subject: `Ticket ${counter}`,
      category: 'other',
      customerId,
      firstResponseDue: new Date(created.getTime() + 3_600_000),
      resolutionDue: new Date(created.getTime() + 4 * 3_600_000),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('ticket insert failed');
  return row;
};

export const rows = async <T extends Record<string, unknown>>(
  db: Db,
  query: ReturnType<typeof sql>,
) => (await db.execute<T>(query)).rows;
