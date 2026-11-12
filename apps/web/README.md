# @helpdesk/web — Next.js 15 (App Router, React 19)

Block 6: the foundation. Sign-in, the authenticated shell, i18n (uk/en), dark theme, the typed API client,
the live-update plumbing (SSE client + the reducer that overlays events on a visible list) and the accessibility primitives.
The customer and staff screens are the next block.

```bash
cp .env.example .env && docker compose up --build      # web on http://localhost:3000 (api only behind /api/*)
pnpm --filter @helpdesk/web test                       # 134 unit tests (Vitest + Testing Library + MSW + axe)
```

## Structure (Feature-Sliced Design)

```
app/                  Next routing shell — each file just re-exports a page from src/pages
pages/                EMPTY on purpose: Next treats src/pages as the Pages Router; this folder makes it ignore it
src/app/              providers (React Query, theme, announcer), styles, next-intl request config
src/pages/            login, home (redirect), tickets, queue            ← compose widgets/features
src/widgets/          app-shell (header, nav, auth gate, <main> landmark)
src/features/         auth-login, switch-locale, toggle-theme, realtime (SSE client)
src/entities/         session (useMe/useLogin/useLogout), ticket (overlay reducer)
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
