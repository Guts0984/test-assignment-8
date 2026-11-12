# @helpdesk/db — database block

Drizzle schema, migrations, reference data, seed, and the DB test-suite. Everything the rest of the
system assumes about PostgreSQL is enforced and tested **here**, so a failure in api/web is never
"the database's fault".

## Run it alone

```bash
cp .env.example .env
docker compose -f docker-compose.db.yml up --build   # postgres + one-shot migrate+seed (≈30 s)
npm run test -w @helpdesk/db                          # needs postgres from `npm run db:up`
```

## Layout

| Path               | What                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------- |
| `src/schema/`      | tables, enums, indexes, CHECK constraints (single source of truth)                     |
| `drizzle/`         | generated SQL migrations (committed; CI fails on drift: `npm run db:check-drift`)      |
| `src/migrate.ts`   | `migrate()` under a PG advisory lock (safe with several api replicas) + reference data |
| `src/reference.ts` | categories, default SLA policies, ticket counter, `allocateTicketNumber()`             |
| `src/seed/`        | deterministic seed (200 customers, 6 agents, 1 lead, 20 000 tickets / 6 months)        |
| `src/testing.ts`   | `createTestDb()` — a fresh, migrated, randomly named database per test file            |
| `src/cli.ts`       | `helpdesk-db migrate                                                                   | seed | setup` (used by Docker) |

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
