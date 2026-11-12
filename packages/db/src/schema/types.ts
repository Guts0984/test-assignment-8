import { customType, timestamp } from 'drizzle-orm/pg-core';

/** PostgreSQL full-text vector. Only ever produced by GENERATED columns, never written by the app. */
export const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
