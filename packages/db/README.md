# @helpdesk/db — database block

Drizzle schema, migrations, reference data, seed, and the DB test-suite. Everything the rest of the
system assumes about PostgreSQL is enforced and tested **here**, so a failure in api/web is never
"the database's fault".

## Run it alone

```bash
cp .env.example .env
docker compose up -d postgres && pnpm db:migrate && pnpm db:seed   # ≈30 s for the 20 000-ticket seed
pnpm test                                             # one summary line; needs postgres from `pnpm db:up`
```

## Layout

| Path               | What                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `src/schema/`      | tables, enums, indexes, CHECK constraints (single source of truth)                            |
| `drizzle/`         | generated SQL migrations (committed; CI fails on drift: `pnpm db:check-drift`)                |
| `src/migrate.ts`   | `migrate()` under a PG advisory lock (safe with several api replicas) + reference data        |
| `src/reference.ts` | categories, default SLA policies, ticket counter, `allocateTicketNumber()`                    |
| `src/seed/`        | deterministic seed (200 customers, 6 agents, 1 lead, 20 000 tickets / 6 months)               |
| `src/testing.ts`   | `createTestDb()` — a fresh, migrated, randomly named database per test file                   |
| `src/cli.ts`       | `helpdesk-db` commands: migrate, seed, setup, reset (the api also migrates and seeds on boot) |

## Seed credentials

| Role            | Login                                                     | Password            |
| --------------- | --------------------------------------------------------- | ------------------- |
| lead            | `lead@helpdesk.test`                                      | `Lead#2026pass`     |
| agent (×6)      | `agent1@helpdesk.test` … `agent6@helpdesk.test`           | `Agent#2026pass`    |
| customer (×200) | `customer001@helpdesk.test` … `customer200@helpdesk.test` | `Customer#2026pass` |

Agents: 1 payment+other · 2 delivery+other · 3 account+technical · 4 technical+payment ·
5 delivery+account · 6 other+payment+delivery. ~3 % of tickets are assigned _across_ categories
(an agent must still see those).

## Decisions

- **Ticket numbers**: one `counters` row, `UPDATE … RETURNING` inside the creating transaction →
  gap-free (a rollback releases the number) and unique. Cost: ticket creation is serialised on that row.
- **Message idempotency**: unique `(author_id, client_id)`; a client id can never collide across users.
- **Full-text**: `simple` configuration on generated `tsvector` columns (PostgreSQL ships no Ukrainian
  stemmer); GIN indexes. No stemming — documented limitation.
- **`sla_due_at`** is a _generated_ column (first deadline → resolution deadline → NULL while paused/resolved/closed),
  so "sort by SLA" is a plain index scan and cannot go stale.
- **Whitespace checks** use `~ '[^[:space:]]'` — PostgreSQL's `trim()` only strips spaces, so `\t\n` would pass
  a `trim()`-based CHECK (found by the tests).
- The seed uses one argon2id hash per role (dev shortcut) and runs in a single transaction under an advisory lock.
- Seed does not simulate past `pending` pauses; paused tickets carry their remaining minutes only.

## Indexes (and what they are for)

Measured with `EXPLAIN (ANALYZE)` on the seeded database (20 000 tickets, 108 000 messages). The same
queries run as tests in `test/seeded.test.ts` with a 50 ms budget each (the assignment allows 200 ms per request).

| Index                                                                                                                                    | Serves                                                                                                                                                | Plan / time                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `tickets_queue_idx` — partial `(category, priority DESC, sla_due_at, created_at) WHERE assignee_id IS NULL AND status IN ('new','open')` | "Take next": most urgent unassigned ticket of the agent's categories (`FOR UPDATE SKIP LOCKED`). Partial, so it only holds the queue, not 20 000 rows | Bitmap Index Scan, 0.2 ms  |
| `tickets_created_idx` `(created_at DESC, id DESC)`                                                                                       | default list order + keyset cursor + period filter; tag and breach filters walk it and stop at the page size                                          | Index Scan, 0.1–0.2 ms     |
| `tickets_updated_idx` `(updated_at DESC, id DESC)`                                                                                       | list sorted by last update + cursor                                                                                                                   | Index Scan                 |
| `tickets_sla_due_idx` `(sla_due_at, id) WHERE sla_due_at IS NOT NULL`                                                                    | list sorted by SLA deadline (paused/resolved tickets have none and are excluded)                                                                      | Index Scan, 0.1 ms         |
| `tickets_customer_idx` `(customer_id, updated_at DESC, id)`                                                                              | a customer's own tickets — every customer request is filtered by this                                                                                 | Index Scan, 0.7 ms         |
| `tickets_assignee_status_idx` `(assignee_id, status) WHERE assignee_id IS NOT NULL`                                                      | "my open", agent visibility of assigned tickets, load per agent                                                                                       | Bitmap Index Scan, 0.4 ms  |
| `tickets_status_cat_idx` `(status, category)`                                                                                            | status/category filters and agent category scoping                                                                                                    | Bitmap Index Scan          |
| `tickets_breached_idx` partial on breach marks                                                                                           | "SLA breached" filter and stats                                                                                                                       |                            |
| `tickets_tags_gin` (GIN on `tags`)                                                                                                       | `tags @> ARRAY[...]`                                                                                                                                  |                            |
| `tickets_search_gin` / `messages_search_gin` (GIN on generated `tsvector`)                                                               | full-text search over subject and message bodies                                                                                                      | see below                  |
| `messages_ticket_idx` `(ticket_id, created_at, id)`                                                                                      | ticket timeline                                                                                                                                       | Bitmap Index Scan, 0.15 ms |
| `tickets_number_uq`                                                                                                                      | lookup by `HD-n`, uniqueness                                                                                                                          |                            |
| `messages_author_client_uq` `(author_id, client_id)`                                                                                     | idempotent message creation                                                                                                                           |                            |
| `tickets_resolved_idx` partial `WHERE status='resolved'`                                                                                 | auto-close job scan                                                                                                                                   | 0.04 ms                    |
| `tickets_sla_scan_idx` partial `WHERE status IN ('new','open')`                                                                          | SLA warning/breach job scan                                                                                                                           |                            |
| `jobs_due_idx`, `jobs_lease_idx`, `jobs_dedupe_uq`                                                                                       | PG job queue: claim due jobs, reclaim expired leases, one scheduled instance per dedupe key                                                           |                            |
| `attachments_orphans_idx` partial `WHERE message_id IS NULL`                                                                             | 24 h orphan clean-up                                                                                                                                  |                            |
| `rate_limits_window_idx`, `sessions_expires_idx`, `event_log_created_idx`, `ticket_presence_expires_idx`                                 | cheap purge of expired rows                                                                                                                           |                            |

### Search

`tickets.search` and `messages.search` are `GENERATED ALWAYS … STORED` `tsvector` columns using the `simple`
configuration (no stemming, no stop-words — no Ukrainian dictionary ships with PostgreSQL). Queries must use
`plainto_tsquery` / `websearch_to_tsquery`: the tests show raw `to_tsquery` throws a syntax error on input like
`a & | b`, which would be a 5xx. A search matches a ticket if the subject **or** any message matches (`UNION` of the
two GIN lookups). A common term (≈8 000 matching messages) takes ~10–30 ms; rare terms are sub-millisecond.
On a table this small PostgreSQL sometimes prefers a ~5 ms sequential scan over the GIN index for the subject
side; the test `GIN index … usable` proves the index is valid for the query form regardless.

## Commands

| Command                               | Effect                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm db:up` / `db:down`              | start / stop the compose PostgreSQL (data stays in the volume)           |
| `pnpm db:migrate`                     | apply migrations + reference data                                        |
| `pnpm db:seed`                        | seed an empty database (`SEED_TICKETS`, `SEED_CUSTOMERS` override sizes) |
| `pnpm db:reset`                       | DROP everything and migrate again (refused when `NODE_ENV=production`)   |
| `pnpm --filter @helpdesk/db generate` | regenerate SQL after editing `src/schema/` (CI fails if you forget)      |
