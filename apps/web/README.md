# @helpdesk/web — Next.js 15 (App Router, React 19)

Foundation (sign-in, shell, i18n uk/en, dark theme, typed API client, SSE client + overlay reducer, accessibility primitives)
and the screens: the customer cabinet and the staff work place.

```bash
cp .env.example .env && docker compose up --build      # web on http://localhost:3000 (api only behind /api/*)
pnpm --filter @helpdesk/web test                       # 295 unit tests (Vitest + Testing Library + MSW + axe)
```

## Structure (Feature-Sliced Design)

```
app/                  Next routing shell — each file just re-exports a page from src/pages
pages/                EMPTY on purpose: Next treats src/pages as the Pages Router; this folder makes it ignore it
src/app/              providers (React Query, theme, announcer), styles, next-intl request config
src/pages/            login, home, tickets, tickets/new, ticket/[id], queue, dashboard, settings  ← compose widgets/features
src/widgets/          app-shell, ticket-thread (timeline), ticket-table, stats-dashboard, sla-settings, canned-manager
src/features/         auth-login, create-ticket, reply-composer, attachments-upload, ticket-sidebar, ticket-filters,
                      bulk-actions, take-next, hotkeys, notifications, rate-ticket, realtime, switch-locale, toggle-theme
src/entities/         session, ticket (queries, filters ⇄ URL, overlay reducers), agent (staff api hooks)
src/shared/           api client, ui kit (shadcn-style), i18n catalogues, form resolver, formatting
```

A layer may import only from layers **below** it — enforced by ESLint (`no-restricted-imports`, checked with a deliberate violation).
Classes are banned in the web (they exist only in the NestJS api).

## Decisions

- **Same-origin API**: the browser only talks to the web origin; Next `rewrites` proxy `/api/*` → the NestJS api, so the `httpOnly` session cookie and the CSRF `Origin` check just work, and SSE passes through (`compress: false`, otherwise gzip would buffer the stream).
- **Locale** is a cookie (`locale=uk|en`, default `uk`) read on the server; switching sets the cookie and refreshes. Catalogues are ICU messages with proper Ukrainian plural forms (one/few/many/other); a test checks both catalogues have the same keys and placeholders.
- **Time zones**: dates are formatted in the **browser's** zone (`useLocalFormat`, `<LocalTime>`); the server prints a placeholder, so there is nothing to mismatch on hydration (tested with a real server-render + `hydrateRoot`).
- **Forms**: React Hook Form with the _shared_ Zod schemas through a small resolver that yields translatable messages (`required`, `email`, `tooBig:200`…) and keeps the schema's transforms (trim, lower-case). Errors are tied to fields (`aria-invalid`, `aria-describedby`, `role=alert`), focus moves to the first invalid field, `noValidate` so the browser's own bubbles don't replace ours.
- **Live updates**: `connectEventStream` validates every SSE frame against the shared schema (malformed / unknown frames are dropped), relies on the browser's reconnect + `Last-Event-ID`; `overlayTicket` merges one fresh ticket into a list _in place_ (older versions and duplicates ignored, untouched rows keep their identity so scroll and selection survive).
- **Accessibility**: skip link, landmarks, one live region (`useAnnounce`), named controls, `aria-current` in the nav; axe runs on the login page (pristine / with errors) and on the shell for every role. Colour contrast needs a real browser and is covered by the Playwright e2e.
- Theme tokens (light/dark) are chosen for WCAG AA contrast pairs.
- TypeScript is pinned to 5.x here: Next 15 needs the JS compiler API (TS 7 has none).

## Screens and what is tested

**Customer** — `/tickets` (own tickets, unread replies highlighted + announced), `/tickets/new`, `/tickets/[id]`.

- _Create_: subject, category, priority (low/normal/high — never urgent), description, attachments (progress + cancel, 5 files, 10 MB, type checked by the server). The **draft** (and its idempotency id) lives in `localStorage` per account: it survives a reload and a failed/duplicated submit cannot create two tickets.
- _Ticket_: conversation without internal notes, reply with attachments, **new replies appear without reload** (SSE → fetch → in-place update, announced to screen readers), "Problem solved", rating 1–5 with a comment after resolution, a reply to a closed ticket opens the new linked one.

**Staff** — `/queue`, `/tickets/[id]`, `/dashboard` and `/settings` (lead).

- _Queue_: filters (status, priority, category, assignee, SLA breached, tags, period, full-text, sort) **stored in the URL** (discrete changes push history so Back works, typing replaces); saved views (My open / Unassigned / SLA burning + your own); table with a live SLA countdown (one shared ticker, overdue rows highlighted); live events patch the list **in place** — untouched rows keep their DOM node, selection and the keyboard cursor survive; multi-select + bulk actions (> 200 are split) with a report of what was skipped and why (it outlives the selection); **Take next**; hotkeys `j`/`k`/`Enter`/`/`/`?` that never fire while typing.
- _Ticket_: timeline (messages, visibly distinct internal notes, field changes), sidebar (status/priority/category/assignee/tags + SLA) with **version-conflict handling**: on 409 or a live change the user sees what changed and keeps everything they typed ("keep my edits on top" re-bases: untouched fields take the other person's value, so nothing is silently overwritten); composer with a reply/note switch that cannot be missed (different colour, label, hint, button text, warning when switching a note to a reply), per-ticket draft, templates with the customer's name and ticket number filled in, drag-and-drop attachments, `Ctrl/⌘+Enter`, "send and wait" / "send and resolve", and "Now replying: Ivan".
- _Bell_: unread counter in the accessible name, panel with links to tickets.
- _Lead_: statistics for a period, SLA deadlines, reply templates.

Bugs the tests found while building this: the bulk report vanished when every selected ticket succeeded (the bar unmounted); a stale form value could overwrite someone else's change after "keep my edits"; the live-follow effect reverted a freshly adopted version; the help dialog called a hook after an early return; a fully loaded list never received a newly matching ticket; hotkeys died after clicking a row checkbox.
