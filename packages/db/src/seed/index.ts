import { hash } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import type { DbHandle } from '../client';
import {
  agentCategories,
  cannedResponses,
  counters,
  messages,
  notifications,
  ratings,
  ticketEvents,
  ticketReads,
  tickets,
  users,
} from '../schema';
import { TICKET_COUNTER } from '../reference';
import { SEED_PASSWORDS, generateDataset, type SeedOptions } from './generate';

export { SEED_PASSWORDS, seedEmail, type SeedOptions } from './generate';

const SEED_LOCK_ID = 7_351_902_115;

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const argon2Hash = (plain: string) => hash(plain);

export type SeedResult =
  | { skipped: true }
  | { skipped: false; tickets: number; messages: number; users: number };

/**
 * Fills an empty database with demo data in ONE transaction (all or nothing), so an interrupted
 * seed never leaves a half-filled database. Idempotent: does nothing if users already exist.
 * Same password per role (hashed once) — a deliberate dev shortcut that keeps seeding fast.
 */
export const seed = async (handle: DbHandle, options: SeedOptions = {}): Promise<SeedResult> => {
  const hasher = options.hashPassword ?? argon2Hash;
  const hashes = {
    lead: await hasher(SEED_PASSWORDS.lead),
    agent: await hasher(SEED_PASSWORDS.agent),
    customer: await hasher(SEED_PASSWORDS.customer),
  };
  const client = await handle.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SEED_LOCK_ID]);
    try {
      const existing = await handle.db.select({ n: sql<number>`count(*)::int` }).from(users);
      if ((existing[0]?.n ?? 0) > 0) return { skipped: true };

      const data = generateDataset(options, hashes);
      await handle.db.transaction(async (tx) => {
        await tx.insert(users).values(data.users);
        await tx.insert(agentCategories).values(data.agentCategories);
        await tx.insert(cannedResponses).values(data.canned);
        for (const c of chunks(data.tickets, 1000)) await tx.insert(tickets).values(c);
        for (const c of chunks(data.messages, 2000)) await tx.insert(messages).values(c);
        for (const c of chunks(data.events, 3000)) await tx.insert(ticketEvents).values(c);
        for (const c of chunks(data.ratings, 3000)) await tx.insert(ratings).values(c);
        for (const c of chunks(data.notifications, 3000)) await tx.insert(notifications).values(c);
        for (const c of chunks(data.reads, 5000)) await tx.insert(ticketReads).values(c);
        await tx
          .update(counters)
          .set({ value: data.lastTicketNumber })
          .where(sql`${counters.name} = ${TICKET_COUNTER}`);
      });
      await handle.db.execute(sql`ANALYZE`);
      return {
        skipped: false,
        tickets: data.tickets.length,
        messages: data.messages.length,
        users: data.users.length,
      };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SEED_LOCK_ID]);
    }
  } finally {
    client.release();
  }
};
