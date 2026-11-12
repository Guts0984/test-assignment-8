import type { Db } from '@helpdesk/db';

/** The transaction handle drizzle passes to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Queryable = Pick<Db, 'execute'>;
