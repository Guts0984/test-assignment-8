# plan.md — Helpdesk (test assignment 8)

Source of truth: `test-assignment-8.md`. If anything here conflicts with it, the assignment wins.

## 0. Working rules

- **Modular blocks, each finished end to end** (code + Dockerfile/compose bits + seed/fixtures + tests + env vars + README section). A block is only committed when its own tests are green, so a later failure is never "the DB's fault".
- **I stop at the sub-checkpoints** listed per block so you can inspect, and commit **only whole blocks** (8 commits). You push when you want.
- **Style:** classes only for NestJS (modules/controllers/services/guards/filters). Everything else — functional (pure functions, plain objects, hooks). No `any`, no `@ts-ignore` without a justification comment.
- **Frontend:** Feature-Sliced Design (`app → pages → widgets → features → entities → shared`), with Next.js `app/` as a thin routing shell re-exporting from FSD pages.
- **Env:** `.env.example` holds *every* variable (secrets included, with dev-only placeholder values; you copy to `.env`). `apps/api/src/env.ts` parses `process.env` with Zod, applies defaults to non-sensitive vars only, and fails fast on missing secrets. No secrets in code.
- **Tests must try to break things**, not confirm happy paths: property/boundary cases, races, hostile input, and for all sensitive surfaces (auth, rate limiting, permissions, uploads, routes) a **real server + real PostgreSQL + a real malicious client** (see block 3).

## 1. Decisions that deviate from your message (assignment wins)

| Your message | Assignment | Decision |
| --- | --- | --- |
| Commit blocks "redis" | Redis explicitly forbidden | **No Redis.** Rate limits, sessions, job queue, locks all live in PostgreSQL. |
| Commit block "nginx" | Compose = `postgres`, `api`, `web` | **No nginx.** Next.js `rewrites` proxy `/api/*` → `api` (same origin, cookie-friendly, SSE passes through). Tell me if you still want nginx as a 4th service; it's not forbidden, just not asked. |
| Monorepo = 3 dirs | `apps/api`, `apps/web`, `packages/shared` | Add **`packages/db`** (Drizzle schema, migrations, seed) so the DB block is independently testable. Additive, not a conflict. |

Other decisions (will also go in README): README language = English; UI default locale `uk`; ticket number from a Postgres sequence-like counter row (see 4.3); cursor pagination = keyset; "Kyiv" business hours via `Intl`/`date-fns-tz`-style pure functions (DST-safe, no DB involvement); `lead` is the only role that edits SLA/canned-response definitions.

## 2. Repository layout

```
apps/api            NestJS (only place with classes)
apps/web            Next.js 15, FSD under src/{app,pages,widgets,features,entities,shared}
packages/shared     Zod schemas + inferred types + pure domain helpers (status transitions, SLA math inputs)
packages/db         Drizzle schema, migrations, seed, migrate/seed CLI
docker/             Dockerfiles (multi-stage, non-root)
.github/workflows/  ci.yml
.env.example  package.json (workspaces)  package-lock.json  docker-compose.yml  README.md  plan.md
```

Tooling: npm workspaces (single root `package-lock.json`), TS strict everywhere, ESLint (ban `any`, `@ts-ignore`-without-comment, class syntax outside `apps/api` via `no-restricted-syntax`), Prettier, Vitest.

## 3. Blocks (= commits)

### Block 1 — Foundation + `packages/shared`
- Workspaces, root scripts (`lint`, `typecheck`, `test`, `test:e2e`), tsconfig base, ESLint rules above.
- `packages/shared`: Zod schemas for every DTO (ticket create/patch, message, bulk, list query/filters, login, SLA settings, canned responses, ratings, stats, SSE event union, error envelope), enums (roles, statuses, priorities, categories), **pure status-transition table + `canTransition()`**.
- `.env.example` skeleton (grows with each block), CI skeleton (lint + typecheck + unit).
- **Tests:** schema boundary tests (subject 0/1/200/201 chars, `urgent` rejected for customer, 5 vs 6 attachments, unicode, huge payloads, prototype-pollution keys), transition table exhaustive (every pair).
- ⏸ Checkpoint: after shared schemas.

### Block 2 — Database (`packages/db`), end to end
- Drizzle schema: `users`, `sessions`, `categories`, `agent_categories`, `tickets`, `ticket_counter`, `messages` (client-generated `id`/idempotency key, `kind` public|internal), `attachments`, `ticket_events` (history), `sla_policies`, `canned_responses`, `notifications`, `ratings`, `saved_views`, `jobs` (queue on PG), `rate_limits`, `login_attempts`, `drafts` not stored server-side (client-only).
- Constraints enforced in DB: CHECKs (subject length, enums), unique ticket number, FK integrity, `version` int on tickets, unique `(ticket_id, client_message_id)`.
- Indexes designed for <200 ms on 20k rows: partial index for the open queue `(category, priority, sla_due) WHERE assignee IS NULL AND status IN (...)` (powers take-next with `FOR UPDATE SKIP LOCKED`), `(assignee, status)`, `(created_at)`, `(updated_at)`, `(sla_first_due)`, GIN on `tsvector` (generated column) for tickets + messages, GIN on `tags`, cursor-friendly composites. Each documented in README with `EXPLAIN` evidence.
- Migrations (generated by drizzle-kit, committed), `migrate()` guarded by an **advisory lock** (safe if several api replicas start).
- **Seed** (deterministic, seeded PRNG): 200 customers, 6 agents with different category sets, 1 lead, **20 000 tickets over 6 months in all statuses**, messages, internal notes, history rows, SLA fields consistent with the rules; credentials table goes into README. Idempotent (skips if already seeded).
- Docker: `postgres:16` service + healthcheck, `docker/db.Dockerfile` target for migrate+seed one-shot, `docker-compose.db.yml` to run this block alone.
- **Tests (real PG via testcontainers-free approach: compose-provided DB / `DATABASE_URL_TEST`, fresh schema per file):** migrations apply from zero and are re-runnable; every constraint rejects bad data; seed counts/distributions correct and idempotent; 50 parallel counter allocations → gapless unique numbers; parallel `SKIP LOCKED` claim → no double claim; `EXPLAIN` asserts index usage + timing budget on seeded 20k rows.
- ⏸ Checkpoints: (a) schema+migrations, (b) seed, (c) tests/Docker.

### Block 3 — API core & security (`apps/api`, no business logic yet)
- NestJS bootstrap, `env.ts` (Zod, defaults for non-secrets), Zod validation pipe (shared schemas), single error envelope + global filter (**any malformed input → 4xx, never 5xx**), Swagger `/docs`, `/health`, `/ready`, graceful `SIGTERM` (drain, exit 0), request-id logging.
- Auth: argon2 password hashing, sessions in PG, `httpOnly` + `SameSite=Lax` (+`Secure` in prod) cookie, session rotation on login, logout invalidation, `GET /me`, role guard + ownership helpers.
- **Rate limiting in PG** (no Redis), layered so an attacker cannot take everyone down:
  - per **IP** token bucket on all routes (spammer gets 429, other IPs unaffected);
  - login failures keyed by **(IP, username)** and by **IP** — *not* by username alone, so a stranger cannot lock the victim out; a correct login from a different IP still works;
  - trusted-proxy config: `X-Forwarded-For` honored **only** from configured proxies, so spoofing the header does not evade or poison limits.
- CSRF stance for cookie auth (Origin/Content-Type check) documented + tested.
- **Tests — real server + real PG + hostile client.** The API is booted as a real process; the attacker is a separate script using distinct real source IPs (`127.0.0.2`, `127.0.0.3`… all loopback on Linux). Attack catalogue (each is a test, and each asserts both "attacker blocked" and "innocent user unaffected"):
  - **Rate limiting / availability:** single-IP flood of every route class (anon, authed, login, upload, SSE); many IPs each under the limit (distributed — documented limit of per-IP defence); slowloris / slow body; huge headers, huge bodies, deep/huge JSON; connection flood on SSE; limiter-table growth (bounded, expired rows purged); limiter itself not a DoS vector (attacker cannot exhaust PG pool and starve a legit user — legit latency measured during attack); race on the limiter counter (N parallel requests never exceed the quota).
  - **Account attacks:** brute force, credential stuffing (many users × few passwords from one IP), password spraying across IPs, victim lockout attempt, user enumeration via response body/status/timing/headers, password-length hash-DoS, login with array/object/NUL/unicode-normalization tricks, email case/whitespace/homoglyph aliases bypassing per-user counters.
  - **Session attacks:** session fixation (pre-login cookie rejected, new id on login), cookie tampering/truncation/other-user cookie, replay after logout, expiry, concurrent sessions cap, cookie flags (`HttpOnly`, `SameSite`, `Secure` in prod), session id entropy.
  - **Header / proxy attacks:** spoofed `X-Forwarded-For` / `X-Real-IP` / `Forwarded` (untrusted peer → ignored; chain with trusted proxy → rightmost-untrusted rule), `Host` header injection, CRLF injection in headers, oversized/duplicated headers.
  - **CSRF / CORS / origin:** cross-site POST with the cookie (forged `Origin`, missing `Origin`, `text/plain` form posts), CORS preflight from foreign origin, SSE from foreign origin.
  - **Injection / parsing:** SQL-looking strings in every field and query param, `tsquery` syntax, prototype pollution (`__proto__`, `constructor`), mass assignment, NoSQL-style operators as JSON objects, path traversal in IDs, invalid UUIDs everywhere, HTTP parameter pollution (`?status=a&status=b`), method override headers, unexpected methods (`TRACE`, `OPTIONS`), non-UTF8 bytes, null bytes, zip/decompression bomb via `Content-Encoding`, invalid `Content-Length`. Everything → 4xx, never 5xx, never stack traces in bodies.
  - **Authorization probes** (re-run against every route as the routes are added in later blocks; a route-table test fails if a new route lacks an auth guard or an explicit `@Public()`): unauthenticated, customer, agent of another category, lead; IDOR with sequential/guessed IDs; horizontal and vertical privilege escalation via PATCH/bulk.
  - **Lifecycle:** `SIGTERM` mid-request finishes it and exits 0; new connections refused while draining; `/ready` flips to 503 on drain and on DB loss; PG outage → 503 with envelope, not a hang or crash.
  - **Info leaks:** `X-Powered-By` absent, errors never contain SQL/stack/paths, Swagger `/docs` does not expose secrets.
- ⏸ Checkpoints: (a) env/bootstrap/errors, (b) auth+sessions, (c) rate limiter + attack suite.

### Block 4 — Tickets domain (API)
- Tickets CRUD, `PATCH` with **optimistic version** (`409` + current state), history rows for status/priority/assignee/category, visibility scoping (customer = own; agent = own categories **or** assigned; lead = all; internal notes stripped at the query layer, not just the serializer).
- Messages: idempotent by client-generated id (insert … ON CONFLICT DO NOTHING + return existing), status auto-transitions (rules in section 2 of the assignment; `closed` + customer reply → **new ticket linked to old**).
- Ticket numbers `HD-n` via counter row `UPDATE … RETURNING` inside the creating transaction (no gaps, no dupes under 50 parallel creates; rolled-back tx doesn't burn a number).
- **SLA engine** (pure functions in `shared`, DB only stores results): business hours Mon–Fri 9–18 Europe/Kyiv (DST), urgent in wall-clock hours, pause/resume in `pending`, priority change recomputes from creation, lead-configurable policy.
- List: all filters, PG full-text (tickets+messages, uk/en config + `simple` fallback), sort by SLA/created/updated, **keyset cursor** pagination, p95 < 200 ms asserted on 20k seed.
- `take-next` (`FOR UPDATE SKIP LOCKED`, most urgent first, agent's categories only), `bulk` (≤200, per-ticket result with reason), canned responses CRUD, saved views, ratings.
- **Tests (real PG):** permission matrix (customer/agent/lead × own/foreign category/assigned × public/internal), IDOR by id guessing, every transition (valid + invalid), SLA table incl. Friday 17:00 `high`, weekends, DST change, pause/resume, priority bump; 6 concurrent take-next → 6 distinct; 2 concurrent patches → one 409; duplicate message id ×N parallel → 1 row; 50 parallel creates; bulk with 200 mixed-permission tickets; search injection strings (`'`, `&`, `:*`, tsquery syntax) → 4xx/empty, never 5xx; fuzz of query params/cursors (tampered cursor → 400).
- ⏸ Checkpoints: (a) tickets+permissions+history, (b) SLA, (c) messages/idempotency/take-next/bulk, (d) list/search/perf.

### Block 5 — API async: attachments, jobs, realtime, stats
- Attachments: stream to disk volume, **magic-byte sniffing** (png/jpeg/gif/webp/pdf/plain text) not extension, 10 MB cap enforced while streaming (no buffering → no memory DoS), ≤5/message, storage names are random (no path traversal), download re-checks ticket permission and note-visibility, `Content-Disposition`/`nosniff`.
- Job queue on PG (`FOR UPDATE SKIP LOCKED`, lease + heartbeat, dedupe keys, injectable clock): SLA breach marking + 30-min warnings (exactly once), auto-close `resolved` after 3 days, orphan-attachment cleanup after 24 h. Restart-safe, no double execution with 2 workers.
- Notifications (assigned, customer replied, SLA soon) + `GET /notifications`, `POST /notifications/read`.
- SSE `/events`: per-user filtered stream (customers never receive internal notes or foreign tickets), heartbeat, `Last-Event-ID` resume, typing/"now replying" presence (TTL in PG), connection cap per user/IP.
- `GET /stats` (lead only): created/resolved, avg first-response/resolution, breach %, avg rating, load per agent.
- **Tests:** `.exe` renamed `.png`, polyglot, 11 MB, 6 files, zero-byte, `../` names, double extension, unauthorized download of note attachment (404 not 403 to avoid leaking existence — documented); jobs with fake clock (auto-close at 3d − 1s vs 3d, customer reply resets), two workers racing one job, crash-and-restart mid-job, orphan cleanup only after 24 h; SSE leak test (customer connection with an agent writing notes), SSE connection flood from one IP; stats correctness against a hand-computed fixture.
- ⏸ Checkpoints: (a) attachments, (b) jobs, (c) SSE+notifications, (d) stats.

### Block 6 — Web foundation (`apps/web`, FSD)
- Next.js 15 / React 19, Tailwind + shadcn/ui, dark theme, next-intl (`uk`, `en`; plural rules via ICU; dates/relative time in the user's timezone), TanStack Query, RHF + Zod resolver (shared schemas), API client (typed, from shared), SSE client + **pure reducer that overlays events onto cached lists** (no scroll/selection reset), auth pages, layout shell, a11y primitives (live region announcer, focus management, skip link, field-error association).
- **Tests (Vitest + RTL + MSW + axe):** forms & their errors (`aria-describedby`/`aria-invalid`), SSE overlay reducer (out-of-order, duplicate, deleted, filter-mismatch events), locale formatting/plurals (uk 1/2/5/21 forms, "через 2 години"/"in 2 hours"), timezone rendering, hydration-warning check (console error = failure).
- ⏸ Checkpoint: shell+auth+i18n working against real API.

### Block 7 — Web features
- **Customer:** create ticket (draft persisted, attachments with progress/cancel), my tickets with unread highlighting, ticket thread (no notes), reply with attachments, live updates + screen-reader announcements, "problem solved" + 1–5 rating.
- **Agent/lead:** queue table (filters in URL, back button, saved views, live SLA countdown, overdue highlight, multi-select + bulk with skipped report, take-next, hotkeys `j/k/Enter//` + `?` help), ticket page (timeline of messages/notes/field changes, sidebar with version-conflict handling that **keeps the user's input**), composer (reply/note toggle with unmistakable mode styling, per-ticket draft, canned responses with `{{customer_name}}`/`{{ticket_number}}`, drag-drop uploads, Ctrl/Cmd+Enter, send-and-wait / send-and-resolve), "Ivan is replying" indicator, notification bell, lead dashboards (stats, SLA settings, canned responses).
- **Tests (unit):** drafts (persist/restore/per-ticket isolation/corrupt storage), hotkeys (not firing inside inputs), bulk report rendering, conflict handling keeps input, composer can't send note as reply by accident, a11y/axe per page.
- ⏸ Checkpoints: (a) customer, (b) queue, (c) ticket page+composer, (d) lead.

### Block 8 — Infra, e2e, CI, README
- Multi-stage Dockerfiles (api, web), non-root user, volume for attachments, compose with `postgres`/`api`/`web`, migrations+seed automatic on boot, healthchecks. Only manual step: `cp .env.example .env`.
- Playwright e2e against the compose stack: customer creates ticket with attachment → agent replies → customer sees it live; internal note invisible to customer (UI + direct API + attachment URL); two agents conflict; bulk with skips; filters/URL/Back; `.exe`-as-`.png` rejected; draft survives reload; axe on key pages; uk/en.
- CI (GitHub Actions): lint, typecheck, unit, api integration (PG service), e2e. Hostile-client suite from block 3 runs in CI too.
- README: run/test, transition table, SLA calculation, take-next/versioning/idempotency, background jobs, indexes+search (+EXPLAIN numbers), seed credentials, decisions, known limitations; verified against actual behavior (acceptance checklist 1–18 walked through manually).
- ⏸ Checkpoint: clean-clone `cp .env.example .env && docker compose up --build`.

## 4. Commit plan

| # | Commit | Gate |
| --- | --- | --- |
| 1 | `chore: monorepo foundation and shared schemas` | shared tests green |
| 2 | `feat(db): schema, migrations, seed, docker` | db tests green on real PG |
| 3 | `feat(api): bootstrap, auth, PG rate limiting, security suite` | attack suite green |
| 4 | `feat(api): tickets, messages, SLA, queue` | domain tests green |
| 5 | `feat(api): attachments, jobs, SSE, notifications, stats` | async tests green |
| 6 | `feat(web): foundation (FSD, i18n, auth, a11y)` | web unit + axe green |
| 7 | `feat(web): customer and staff features` | web unit green |
| 8 | `chore: docker, e2e, CI, README` | clean-clone compose + e2e green |

## 5. Open questions (defaults I'll use unless you object)

1. No nginx, no Redis (see section 1).
2. `packages/db` added as a fourth workspace package.
3. Password hashing = argon2 (native module; falls back to `@node-rs/argon2` prebuilt to keep Docker builds simple).
4. Foreign-resource access returns **404** (not 403) to avoid existence leaks; documented in README.
5. README and code in English; seed names a mix of Ukrainian/English to exercise i18n.
