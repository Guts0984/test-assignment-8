import { CATEGORIES, DEFAULT_SLA_POLICIES, PRIORITIES } from '@helpdesk/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { categories, counters, slaPolicies } from './schema';

export const CATEGORY_NAMES: Readonly<
  Record<(typeof CATEGORIES)[number], { uk: string; en: string }>
> = {
  payment: { uk: 'Оплата', en: 'Payment' },
  delivery: { uk: 'Доставка', en: 'Delivery' },
  account: { uk: 'Акаунт', en: 'Account' },
  technical: { uk: 'Технічна проблема', en: 'Technical problem' },
  other: { uk: 'Інше', en: 'Other' },
};

/** First ticket number handed out is FIRST_TICKET_NUMBER + 1 → HD-1001. */
export const FIRST_TICKET_NUMBER = 1000;
export const TICKET_COUNTER = 'ticket_number';

/** Idempotent. Rows the app owns (SLA edited by lead) are never overwritten. */
export const ensureReferenceData = async (db: Db): Promise<void> => {
  await db
    .insert(categories)
    .values(
      CATEGORIES.map((slug, i) => ({
        slug,
        nameUk: CATEGORY_NAMES[slug].uk,
        nameEn: CATEGORY_NAMES[slug].en,
        sortOrder: i,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(slaPolicies)
    .values(PRIORITIES.map((priority) => ({ priority, ...DEFAULT_SLA_POLICIES[priority] })))
    .onConflictDoNothing();
  await db
    .insert(counters)
    .values({ name: TICKET_COUNTER, value: FIRST_TICKET_NUMBER })
    .onConflictDoNothing();
};

/** Allocates the next ticket number. MUST run inside the transaction that inserts the ticket. */
export const allocateTicketNumber = async (tx: Pick<Db, 'execute'>): Promise<number> => {
  const res = await tx.execute<{ value: string | number }>(
    sql`UPDATE counters SET value = value + 1 WHERE name = ${TICKET_COUNTER} RETURNING value`,
  );
  const row = res.rows[0];
  if (!row) throw new Error('ticket counter row is missing — run migrations');
  return Number(row.value);
};

export const formatTicketNumber = (n: number): string => `HD-${n}`;
