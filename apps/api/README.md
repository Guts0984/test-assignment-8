# @helpdesk/api — NestJS

Block 3: bootstrap, configuration, authentication, rate limiting, error handling, health, shutdown.
(Tickets, attachments, jobs, SSE arrive in later blocks and plug into the same guard/filter/limiter.)

```bash
pnpm db:up && pnpm --filter @helpdesk/api build && node apps/api/dist/main.js   # needs .env (cp .env.example .env)
pnpm test                                       # one summary line
pnpm --filter @helpdesk/api exec vitest run test/attack.test.ts   # the hostile-client suite alone
```

Swagger: `/docs` (JSON: `/docs-json`). Health: `GET /health` (liveness, no DB), `GET /ready` (DB reachable and not draining).

## Layout

| Path          | What                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/env.ts`  | **all** configuration, parsed with Zod; non-secrets have defaults, `DATABASE_URL` (the only secret) does not; errors name the variable, never its value |
| `src/lib/*`   | pure/functional core: client-IP resolution, cookies, sessions, PG limiter, in-process gate, semaphore, error mapping, CSRF policy                       |
| `src/http/*`  | Express middleware (request id + headers + access log, rate limit, CSRF, last-resort error handler), Zod pipe, exception filter                         |
| `src/auth/*`  | login flow, global `AuthGuard` (deny-by-default, `@Public()` / `@Roles()`), controller                                                                  |
| `src/main.ts` | bootstrap, own `http.Server` (timeouts), graceful shutdown                                                                                              |

Classes exist only where NestJS needs them (controllers, guard, filter, pipe, modules).

## Security model

| Concern        | Decision                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions       | 256-bit random token in an `httpOnly`, `SameSite=Lax` (`Secure` in production) cookie; only `sha256(token)` is stored in PostgreSQL; rotated on login (a presented cookie is destroyed — no fixation); max `SESSION_MAX_PER_USER`, oldest evicted; disabled users die immediately; a cookie name appearing twice is rejected (cookie tossing)                                        |
| Brute force    | counters keyed by **(address)** and **(address + account)** — never by account alone, so an attacker cannot lock a victim out; an attempt is _reserved_ before the password is checked (racing guesses cannot overshoot) and refunded on success; unknown accounts cost the same as real ones (dummy hash); argon2 runs behind a bounded semaphore (excess is refused fast with 429) |
| Flooding       | fixed-window quota per client in PostgreSQL (atomic upsert, shared by replicas), fronted by an in-process gate so a flood is rejected without touching the database; IPv6 clients are limited per /64; `/health` never needs the DB                                                                                                                                                  |
| Client address | `X-Forwarded-For` honoured **only** from `TRUSTED_PROXIES`, rightmost-untrusted-hop rule; from anyone else it is ignored (tests: spoofing, rotating, victim-poisoning)                                                                                                                                                                                                               |
| CSRF           | state-changing requests need an allowed `Origin`; `null`/foreign → 403; no `Origin` → `Sec-Fetch-Site` must be same-origin/none; JSON-only bodies (a cross-site `<form>` cannot send them); CORS allow-list with credentials, never `*`                                                                                                                                              |
| Slow clients   | own `http.Server` with `connectionsCheckingInterval` ≤ 1 s (Node's default sweep is **30 s**, which let a slowloris socket outlive `headersTimeout` — found by the attack tests), `headersTimeout`, `requestTimeout`, body-size limit, gzip-bomb safe (limit applies after inflation)                                                                                                |
| Errors         | one envelope; bad input is always 4xx (NUL bytes, bad UUIDs, deep JSON, invalid encodings, bad percent-escapes…); PostgreSQL errors are mapped (data errors → 400, unique → 409, outage/timeouts → 503 + `Retry-After`); unknown faults → generic 500; messages of non-application errors are fixed strings (no echo of request fragments, no SQL, no paths)                         |
| Authorization  | every route requires a session unless `@Public()`; a test walks the OpenAPI document and calls every route anonymously (must be 401) so a new unguarded route fails CI; `@Roles()` is enforced after authentication                                                                                                                                                                  |
| Shutdown       | SIGTERM/SIGINT: stop accepting, readiness → 503, in-flight requests finish, idle keep-alive sockets are closed, pool drained, exit `0` (forced exit `1` after `SHUTDOWN_TIMEOUT_MS`)                                                                                                                                                                                                 |

### Known limitations

- A _distributed_ attack on one account (many addresses, each under its limit) is not blocked — by design: an account-wide lock-out would let anyone lock anyone out. Argon2 cost + per-address budgets + the global hashing gate are the defence. Add CAPTCHA/MFA for more.
- Users behind one shared address (NAT) share its budget; failures only count, successes are refunded.
- Rate-limit rows are purged every 60 s in-process (moves to the PG job queue in a later block).
- No account e-mail/password-reset flows (no mail service allowed by the assignment).

## Tests (real server process + real PostgreSQL)

`test/harness.ts` spawns `node dist/main.js` on a free port against a throw-away database and talks to it from
chosen source addresses (every `127.x.y.z` is local on Linux), so “an attacker” and “an innocent user” are different
clients of the same running server. Suites: `unit` (pure functions), `limiter` (atomicity under 200 parallel hits,
two pools), `hostile-input` (68 malformed-body cases + 22 raw-TCP cases + deny-by-default route walk), `auth`,
`attack` (flooding, brute force, stuffing, spraying, spoofed headers, trusted proxy, slowloris, slow body,
connection floods, distributed login floods — each asserts the attacker is stopped **and** innocents are not),
`csrf-cors`, `lifecycle` (SIGTERM mid-request, database loss, startup validation).

---

# Tickets domain (block 4)

Routes: `POST/GET /tickets`, `GET/PATCH /tickets/:id`, `POST /tickets/:id/messages`, `POST /tickets/:id/read|rating`,
`POST /tickets/take-next`, `POST /tickets/bulk`, `GET/POST/PUT/DELETE /canned-responses`, `GET/POST/DELETE /saved-views`,
`GET/PUT /sla`, `GET /agents`. (Attachments, SSE, notifications list, stats and background jobs: block 5.)

## Status rules

| From → To                             | Who / how                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `new`/`pending` → `open`              | staff **public** reply (automatic)                                                                     |
| `pending`/`resolved` → `open`         | **customer** reply (automatic)                                                                         |
| `new`, `open`, `pending` → `resolved` | staff by hand or with "send and resolve"; **customer** ("problem solved")                              |
| `new`, `open` → `pending`             | staff by hand or "send and wait"                                                                       |
| `pending` → `open`                    | staff by hand                                                                                          |
| `resolved` → `open`                   | staff by hand (reopen)                                                                                 |
| `resolved` → `closed`                 | staff by hand, or **automatically after 3 days without a customer reply** (job, block 5)               |
| `closed` → anything                   | **never**: a customer reply creates a **new ticket linked to the old one**; staff cannot reply or edit |
| anything → `new`, self-transitions    | not allowed (a self-"change" is a no-op: no version bump, no history)                                  |

The table lives in `packages/shared` (`transitions.ts`) and is tested for every pair and role. Internal notes never change status
and never count as a first response. A reply with `setStatus` is validated against the status _after_ the automatic effect
(`new` + reply + `pending` = one net change `new → pending`).

## Who sees and changes what

|                         | customer                                    | agent                                                    | lead                                         |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| sees                    | own tickets                                 | tickets of own categories **or assigned to them**        | all                                          |
| internal notes          | never (filtered **in SQL**, also in search) | yes                                                      | yes                                          |
| SLA data, tags, history | no                                          | yes                                                      | yes                                          |
| change                  | only → `resolved`                           | status, priority, tags; take a free ticket / release own | everything; assignee must be an active agent |
| category                | —                                           | no (lead only)                                           | yes                                          |

A ticket the caller may not see is answered `404`, identical to a non-existent id (no existence oracle).

## Concurrency

- **Version**: `PATCH` carries the version it saw. The row is locked (`FOR UPDATE`) and compared; mismatch → `409 version_conflict` with the _current_ ticket
  in `error.current`. Nothing is overwritten silently. Only real changes bump the version (a chat message does not, so sidebar edits aren't disturbed).
- **Idempotent replies**: the client generates the message id; `UNIQUE (author, client_id)` plus the ticket row lock make a repeat (double click, retry)
  return the original message (`200`, `replayed: true`). Same id with different content or on another ticket → `409`. Ticket creation works the same way.
- **Ticket numbers**: counter row incremented inside the creating transaction (gap-free; a failed creation burns nothing).
- **Take next**: `ORDER BY priority DESC, sla_due_at ASC … FOR UPDATE SKIP LOCKED LIMIT 1` — simultaneous callers lock _different_ rows and never wait for each other
  (tested by holding the top row in another transaction).
- **Bulk**: ≤ 200 ids, each ticket in its own transaction; the answer lists every id as applied or skipped with a reason
  (`not_found_or_forbidden`, `invalid_transition`, `closed`, `unchanged`, `assignee_not_eligible`). Bulk ignores optimistic versions (documented).

## SLA

Deadlines are computed at creation from `sla_policies` (editable by the lead; applies to new tickets and priority changes). Business time = Mon–Fri 09:00–18:00 Europe/Kyiv, DST-aware, no public holidays.
`urgent` is wall-clock (1 h / 4 h). `high` 4 h / 1 business day (540 min), `normal` 1 / 3 business days, `low` 2 / 5.

- `pending` **pauses** the clock: the remaining minutes of each open deadline are stored; leaving `pending` restarts them (`now + remaining`, in business time where the policy says so).
- A **priority change** recomputes both deadlines **from the moment of creation** and re-derives the warned/breached marks.
- **Reopening** a resolved ticket grants a fresh resolution window (never shorter than what was left) and re-arms the warning; an earlier resolution breach stays on record (statistics do not forget it).
- The planners are pure functions (`src/tickets/sla-plan.ts`) with fixed-date unit tests (Friday 17:00 `high`, a week in `pending`, weekends, DST…).

## Search & pagination

`GET /tickets`: filters (status, priority, category, assignee = `me`/`none`/id, `slaBreached`, tags (all of), period), `q` (PostgreSQL full-text, `simple` config, over subject **and** messages — customers only match public messages),
sort by SLA deadline / created / updated, **keyset cursor** `(sort key, id)`; the cursor is bound to its sort/order and validated (tampered → `400`).
Over 20 000 seeded tickets the test suite asserts p95 < 200 ms and worst < 400 ms across lists, searches and 150-page-deep cursors, for every role.

## Decisions & limitations

- Timestamps that feed cursors are written from JavaScript (millisecond precision); a test asserts no row has sub-millisecond precision.
- Customers cannot create `urgent`; when a customer reopens a closed ticket whose priority is `urgent`, the new ticket is `high`.
- Agents cannot change the category (a moved ticket could vanish from their view); the lead re-routes.
- Changing SLA policies does not retro-fit existing tickets.
- Tag filter is AND (`tags=a,b` = both).

---

# Attachments, jobs, realtime, stats (block 5)

## Attachments

`POST /attachments` (multipart, field `file`) → `{ id, name, mime, sizeBytes }`; send the id in `attachmentIds` of a message or a new ticket. `GET /attachments/:id` downloads.

- **Type by content**: magic bytes decide (png, jpeg, gif, webp, pdf; otherwise valid UTF-8 text without control characters = `text/plain`). The name and the client's `Content-Type` are ignored. An `.exe` renamed `.png` → `415`. HTML/SVG are just text: stored as `text/plain` and served inert (never executed).
- **Size**: 10 MB enforced **while streaming** (a counting stream in front of Node's multipart parser): a 5 GB body is cut off after the limit, never buffered whole. Empty files, extra fields, a second file, malformed or truncated multipart → `4xx`, nothing on disk, no row.
- **Disk**: random UUID names, written to a temp file and renamed atomically; the display name is sanitised (no directories, control or bidi characters). The DB row and the file are rolled back together. Directory = `UPLOADS_DIR` (docker volume `/data/uploads`).
- **Quotas**: `UPLOAD_PER_MIN` per user, at most `UPLOAD_MAX_PENDING` unsent files per user, at most `UPLOAD_CONCURRENCY` uploads processed at once (each is buffered, ≤ 10 MB).
- **Access**: a sent file is readable by whoever can read its message: ticket owner / agent of the category or assignee / lead — and **never by a customer if the message is an internal note**; an unsent file only by its uploader. Everything else is `404`, identical to "does not exist".
- **Serving**: `X-Content-Type-Options: nosniff`, exact detected type, forced download for PDF/text (images inline), `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`.
- Unsent uploads are deleted after 24 h by a job (row first, then the file); stale `.tmp-` files after 1 h.

## Background jobs (PostgreSQL, no external queue)

| Job                  | Every  | What                                                                                                                                                                      |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sla-scan`           | 60 s   | warns the assignee **30 min before** a deadline; marks first-response / resolution **breaches** (stamped with the deadline); only tickets whose clock runs (`new`/`open`) |
| `auto-close`         | 60 s   | `resolved` with no customer reply for **3 days** → `closed` (history actor = system)                                                                                      |
| `orphan-attachments` | 10 min | deletes unsent uploads older than 24 h                                                                                                                                    |
| `housekeeping`       | 5 min  | purges stale rate-limit rows, presence, event log (> 1 day), finished jobs (> 7 days), expired sessions                                                                   |

Queue: table `jobs`; claim = `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` with a **lease** (`JOB_LEASE_SECONDS`). A crashed worker's job returns to the queue when the lease expires; failures retry with exponential backoff up to `max_attempts`. Each recurring job has one dedupe key, so exactly one instance is ever queued (finish + next-schedule happen in one transaction). Handlers are idempotent (`UPDATE … WHERE mark IS NULL`, deduplicated notifications), so two api instances never act twice — tested with 2 racing workers, parallel scans and crash recovery. Handlers take an injectable clock; tests move time instead of sleeping. SIGTERM stops polling and waits for the job in progress.

## Realtime (SSE)

`GET /events`: `message.created`, `ticket.created`, `ticket.changed`, `notification.created`, `presence`. Events are written to `event_log` in the same transaction as the change; `pg_notify` wakes the dispatcher (a dedicated `LISTEN` connection; a 3 s poll is the safety net, it reconnects by itself). **Permissions are checked at delivery, per connection and per event**: customers never get internal-note events or other tickets; an agent stops receiving a ticket the moment it leaves their scope; notifications go only to their target. `Last-Event-ID` replays what was missed (last hour, same filters). Caps per user and per address, heartbeat every `SSE_HEARTBEAT_MS` which also **ends the stream when the session is gone**, slow consumers are dropped, SIGTERM closes all streams first.

`POST /tickets/:id/typing` / `GET /tickets/:id/presence` ("Ivan is replying"): staff only, expires after 8 s without refresh.

## Notifications & stats

`GET /notifications` (latest 50 + unread count, hides tickets the user can no longer see), `POST /notifications/read`. `GET /stats?from&to` (lead): created, resolved, average first response / resolution (wall-clock seconds), % of created tickets that breached an SLA, average rating, load per agent. Checked against a hand-computed fixture.

## Decisions & limitations

- Uploads are buffered in memory (≤ 10 MB × `UPLOAD_CONCURRENCY`) behind a bounded semaphore; streaming straight to disk would need a multipart library (a dependency I avoided).
- SLA warnings/breaches notify the **assignee** only; unassigned tickets are marked (so the lead's "breached" filter works) but nobody is notified.
- Averages use wall-clock time, not business time.
- A file whose DB row was deleted but whose process died before unlinking it stays on disk (no row points to it); the temp-file sweep covers interrupted uploads only.
