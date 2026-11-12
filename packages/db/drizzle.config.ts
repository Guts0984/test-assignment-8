import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  // Only needed for `drizzle-kit studio/push`; `generate` does not connect.
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost/helpdesk' },
});
