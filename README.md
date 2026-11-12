# Helpdesk

Customer support: customers open tickets and talk to support; agents work the queue, reply and watch the deadlines;
a lead assigns work and sees the whole picture. NestJS + PostgreSQL (Drizzle) + Next.js, everything in one pnpm monorepo.

```
apps/api         NestJS (the only place with classes)       → apps/api/README.md
apps/web         Next.js 15 / React 19, Feature-Sliced Design → apps/web/README.md
apps/e2e         Playwright
packages/shared  Zod schemas, DTO types, status rules, SLA time math
packages/db      Drizzle schema, migrations, seed            → packages/db/README.md
```

## Run

```bash
cp .env.example .env          # the only manual step
docker compose up --build     # postgres + api (migrates and seeds on boot, ~30 s) + web + nginx
```

Everything is on **one port, 8080**, behind nginx: the app at <http://localhost:8080>, the API at <http://localhost:8080/api> (health: `/api/health`), Swagger at <http://localhost:8080/docs>. Only nginx is published; `api` and `web` are internal. nginx sets `X-Forwarded-For` itself (never forwards a client-supplied one) and the api trusts only the private compose network, so rate limiting sees real client addresses.
Attachments live in the `uploads` volume.

**Accounts** (all seeded; 20 000 tickets over six months, 200 customers, 6 agents, 1 lead):

| Role     | Login                                                     | Password            | Works with                                                                                                                     |
| -------- | --------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| lead     | `lead@helpdesk.test`                                      | `Lead#2026pass`     | everything                                                                                                                     |
| agent    | `agent1@helpdesk.test` … `agent6@helpdesk.test`           | `Agent#2026pass`    | 1 payment+other · 2 delivery+other · 3 account+technical · 4 technical+payment · 5 delivery+account · 6 other+payment+delivery |
| customer | `customer001@helpdesk.test` … `customer200@helpdesk.test` | `Customer#2026pass` | own tickets                                                                                                                    |

## Tests

```bash
pnpm install
pnpm db:up                    # PostgreSQL for the integration tests
pnpm test                     # ONE line: total / passed / failed (details: pnpm test:verbose)
pnpm lint && pnpm typecheck
# e2e against the real stack (small seed, relaxed limits):
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --build --wait
pnpm --filter @helpdesk/e2e exec playwright install chromium
pnpm --filter @helpdesk/e2e exec playwright test --project=chromium
```

CI (GitHub Actions) is split into independent jobs that run in parallel: **lint**, **typecheck**, **build** (shared · db · api · web),
**migrations in sync with the schema**, **nginx config** (`nginx -t`), **tests · shared**, **tests · web**, **tests · db**, **tests · api**, and
**one separate e2e job per browser** (chromium, firefox, webkit). API and database tests run against a real PostgreSQL; the security suite
boots the real server process and attacks it (brute force, floods, spoofed headers, slowloris, CSRF, hostile input). The **nginx-layer tests**
put the real `docker/nginx/default.conf` in front of a real API and check that every client address (device) is counted separately, that a
spoofed `X-Forwarded-For` changes nothing, that login lock-outs are per device, and that cookies, CSRF, SSE and uploads behave through the proxy.

## Ticket statuses

`new → open → pending → resolved → closed`. Replies move tickets automatically; everything else is a manual change.

| From → To                             | Who / how                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `new`/`pending` → `open`              | an agent's **public** reply (automatic)                                                              |
| `pending`/`resolved` → `open`         | the **customer's** reply (automatic)                                                                 |
| `new`, `open` → `pending`             | staff (also "send and wait for customer")                                                            |
| `pending` → `open`                    | staff                                                                                                |
| `new`, `open`, `pending` → `resolved` | staff ("send and resolve") or the customer ("problem solved")                                        |
| `resolved` → `open`                   | staff (reopen)                                                                                       |
| `resolved` → `closed`                 | staff, or automatically after **3 days without a customer reply** (background job)                   |
| `closed` → anything                   | never: a customer's reply creates a **new ticket linked to the old one**; staff cannot reply or edit |
| anything → `new`, a status to itself  | not allowed (a no-op writes nothing)                                                                 |

Internal notes never change the status and never count as the first response. Customers may only mark a ticket solved.

## SLA

| Priority | First reply     | Resolution       |
| -------- | --------------- | ---------------- |
| urgent   | 1 h             | 4 h (wall clock) |
| high     | 4 h             | 1 business day   |
| normal   | 1 business day  | 3 business days  |
| low      | 2 business days | 5 business days  |

Business time = Mon–Fri 09:00–18:00 **Europe/Kyiv** (DST-aware; public holidays are not modelled); a business day is 540 minutes.
The lead edits the table (it applies to new tickets and priority changes).

- **`pending` pauses the clock**: the minutes left on each deadline are stored; on return the deadline is `now + remaining` (business time where the policy says so).
- **A priority change recomputes both deadlines from the moment of creation**, then re-derives the warned/breached marks.
- **Reopening** a resolved ticket grants a fresh resolution window (never shorter than what was left).
- Example (acceptance #10): a `high` ticket created **Friday 17:00** → first reply due **Monday 12:00**, resolution **Monday 17:00**.
- A background job warns the assignee 30 minutes before a deadline and marks breaches (exactly once).

## How the hard parts work

- **Take next** — `ORDER BY priority DESC, sla_due_at ASC … LIMIT 1 FOR UPDATE SKIP LOCKED`, assignment in the same transaction. Six simultaneous callers lock six _different_ rows and never wait for each other (tested, including a test that holds the top row in another transaction).
- **Versions** — `PATCH` carries the version it saw. The row is locked and compared; a mismatch returns `409` with the _current_ ticket. Nothing is overwritten silently. Only real changes bump the version. The UI shows what changed and keeps the user's input; "keep my edits on top" re-bases so fields the user did not touch adopt the other person's value.
- **Idempotent replies** — the client generates the message id; `UNIQUE (author, client_id)` plus the ticket row lock turn a double click or a retry after a dropped connection into the _same_ message (`replayed: true`). Same id with different content → `409`. Ticket creation works the same way; the web app persists the id with the draft.
- **Ticket numbers** — one counter row updated inside the creating transaction: gap-free and unique under 50 parallel creations; a failed creation burns nothing.
- **Bulk** — up to 200 tickets, each in its own transaction; the answer lists every ticket as applied or skipped with a reason.
- **Permissions** are applied in SQL, not after loading: customer = own tickets, agent = own categories **or assigned to them**, lead = all. Internal notes are filtered in queries, in search, in SSE and in downloads. A ticket you may not see answers `404`, identical to a non-existent one.
- **Realtime** — events are written to `event_log` in the same transaction as the change; `LISTEN/NOTIFY` wakes the dispatcher; permissions are checked **per connection and per event at delivery**; `Last-Event-ID` replays what a reconnecting client missed.

## Background jobs (PostgreSQL, no external queue)

`sla-scan` (every 60 s), `auto-close` (60 s), `orphan-attachments` (10 min), `housekeeping` (5 min). `FOR UPDATE SKIP LOCKED` claim with a lease, retry with
backoff, one queued instance per recurring job (dedupe key), idempotent handlers. A restart loses nothing and repeats nothing (tested with two racing
workers and a crashed worker). Handlers take an injectable clock, so "resolved for 3 days" is tested by moving time, not sleeping. Details: `apps/api/README.md`.

## Indexes and search

Every list query over 20 000 tickets is well under 200 ms (asserted in tests: p95 < 200 ms, worst < 400 ms for lists, searches and deep cursors).
Partial index for the queue, keyset indexes for each sort, GIN on tags and on generated `tsvector` columns (PostgreSQL full-text, `simple`
configuration, over subject **and** messages). The full index table with `EXPLAIN` numbers is in `packages/db/README.md`.

## Decisions and known limitations

- **No Redis, no queue, no mail, no S3** (forbidden): sessions, rate limits, jobs, locks and the event log live in PostgreSQL; files on a volume.
- **Rate limiting** is per client address (IPv6 per /64) and per (address + account) — never per account alone, so nobody can lock a victim out. Past the soft limits (`LOGIN_IP_MAX_FAILURES`, `LOGIN_PAIR_MAX_FAILURES`) only _wrong_ passwords get 429; the right password still signs in, so someone behind the same office NAT as an attacker is not locked out. Hard caps (`LOGIN_*_HARD_MAX_FAILURES`) refuse everything unchecked and bound the guessing.
- **TLS is required outside localhost.** The compose stack serves plain HTTP on :8080 (`COOKIE_SECURE=false`) for a local demo: the session cookie (`hd_session`, HttpOnly, SameSite=Lax) would travel in clear text on a real network. In production terminate TLS in front of nginx (it forwards `X-Forwarded-Proto`; nginx then sends HSTS), set `COOKIE_SECURE=true` and `CORS_ORIGINS=https://…`.
- **Uploads** are validated by content _structure_ (PNG chunks + CRC + IEND, JPEG markers + EOI, GIF trailer, WebP RIFF length, PDF startxref/%%EOF), not by the first bytes alone, and the file extension must agree with the detected type (`evil.exe` holding a PNG, `run.bat`, `a.html` are refused).
- Logout clears local drafts and closes the account's live event streams of that session immediately. A _distributed_ attack on one account is limited only by hashing cost and per-address budgets; add MFA/CAPTCHA for more. `X-Forwarded-For` is trusted only from `TRUSTED_PROXIES`.
- One origin (nginx): cookies and the CSRF `Origin` check just work, SSE streams through with buffering off. `CORS_ORIGINS` must match the public URL (`http://localhost:8080`).
- Averages in statistics use wall-clock time; public holidays are not modelled; SLA warnings notify the assignee only.
- Uploads are buffered in memory (≤ 10 MB × a small concurrency limit) rather than streamed to disk, to avoid a multipart dependency.
- Full-text search uses the `simple` configuration (no Ukrainian stemmer ships with PostgreSQL), so there is no stemming.
- Agents cannot change a ticket's category (it could vanish from their view); the lead re-routes.
- The e2e suite is run in CI per browser; running it locally needs `playwright install` (see above).
