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
