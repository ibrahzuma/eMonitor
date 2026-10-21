# eMonitor — web frontend

Single-page application for the eMonitor monitoring platform (servers, websites/APIs, network devices,
services, logs, incidents, alerting, notifications, maintenance, reports/SLOs and administration).

Stack: Vite + React 18 + TypeScript (strict), Tailwind CSS v4, Radix UI primitives with hand-written
shadcn-style components (`src/components/ui`), TanStack Query v5, React Router v6, Recharts, lucide-react.
Tests: Vitest + Testing Library + jsdom + MSW.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
```

The dev server proxies `/api` (HTTP **and** WebSocket) to the backend at `http://127.0.0.1:8000`
(override with `EMONITOR_BACKEND_URL=http://host:port npm run dev`). Sign in with an account that exists in the
backend (dev seed: `admin@example.com`).

| Script              | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Vite dev server with API/WebSocket proxy        |
| `npm run build`     | Type-check (`tsc -b`) and production build → `dist/` |
| `npm run preview`   | Serve the production build locally              |
| `npm run typecheck` | TypeScript only                                 |
| `npm run lint`      | ESLint (typescript-eslint, react-hooks)         |
| `npm test`          | Vitest (jsdom + MSW)                            |

## Configuration

| Variable        | Default   | Description |
| --------------- | --------- | ----------- |
| `VITE_API_BASE` | `/api/v1` | Base URL of the API as seen by the browser. Keep it relative in production so the SPA and the API share an origin (cookies are `SameSite=Strict`). |

`EMONITOR_BACKEND_URL` (dev only) sets the Vite proxy target.

## Production

`npm run build` writes static files to `dist/`. Serve them with nginx and route `/api/` (including the
`/api/v1/ws` WebSocket upgrade) to the backend on the same origin; every other path must fall back to
`index.html` (client-side routing):

```nginx
location /api/ {
    proxy_pass http://emonitor_api;   # upstream pointing at the FastAPI service
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location / {
    try_files $uri /index.html;
}
```

## Architecture

```
src/
  api/          client.ts (fetch wrapper, auth/refresh, errors, downloads), endpoints.ts (typed API functions),
                queryKeys.ts (TanStack Query keys)
  types/        api.ts — TypeScript mirror of the backend Pydantic contracts
  components/   ui/ (Radix-based primitives: button, input/field, dialog, menus, tabs, table, toast, states…),
                common.tsx (status/severity badges, pagination, tag input, code/JSON blocks…),
                pickers.tsx (resource/group/team/member/channel/policy pickers), charts.tsx (Recharts wrappers)
  features/     auth/ (AuthProvider, permissions), realtime/ (WebSocket provider), checks/ (per-type check
                config specs + editor), resources/ (shared resource detail panels), alerts/ (rule form)
  layouts/      AppLayout (collapsible sidebar, top bar: org switcher, global search, theme, inbox, user menu)
  pages/        one folder per area (overview, servers, inventory, websites, devices, services, logs, incidents,
                alerts, notifications, maintenance, reports, integrations, users, audit, settings, profile, auth)
  hooks/        useApi (mutations with toasts, 422 field errors, URL filter state), useTheme
  routes/       AppRoutes (route table, auth guard, lazy-loaded pages)
  utils/        formatting (time zone aware), status colors, cn()
  test/         MSW server, fixtures, render helpers, setup
```

### API client (`src/api/client.ts`)

* All requests go to `VITE_API_BASE` (default `/api/v1`); the browser never talks to databases.
* The **access token is kept in memory only** (`tokenStore`), never in `localStorage`/`sessionStorage`.
* Each request carries `Authorization: Bearer <token>` and `X-Organization-ID: <selected org>`. The selected
  organization id (not a secret) is persisted in `localStorage` (`emonitor.org`).
* Errors are parsed from the backend envelope `{"error": {code, message, details, request_id}}` into an
  `ApiError` (status, code, message, details, requestId, retryAfter). `fieldErrors()` maps 422 `details[].loc`
  to form field names (`["body","config","url"]` → `config.url` and `url`); `Retry-After` is exposed for 429.
* **Refresh-on-401:** any 401 triggers one `POST /auth/refresh` (cookie `emonitor_refresh` is HttpOnly and
  scoped to `/api/v1/auth`; the readable `emonitor_csrf` cookie is echoed in `X-CSRF-Token`). Concurrent 401s
  share a single refresh promise; the original request is retried once. If refreshing fails the session is
  cleared and the app returns to `/login`.
* File downloads (CSV/PDF exports) use `fetch` with the auth header and a Blob URL (`downloadFile`).

### Authentication (`src/features/auth/AuthProvider.tsx`)

On load the app attempts a silent refresh to restore the session, then loads `GET /auth/me` (user,
memberships, per-organization permissions). Login supports the MFA step (`mfa_required` → `POST
/auth/login/mfa`). Logout calls `POST /auth/logout` with the CSRF header. `useCan(permission)` / `<Can>` hide
or disable controls the user lacks (the backend still enforces every permission). The user's `timezone`
drives all timestamp rendering (`utils/format.ts`); the browser time zone is the fallback.

### Data fetching & query keys (`src/api/queryKeys.ts`)

Keys start with a domain prefix (`["incidents", ...]`, `["resources", ...]`, `["dashboard", ...]`,
`["inbox"]`, …) so mutations and live events can invalidate whole domains. Switching organization clears the
entire cache. 4xx errors are not retried; background refresh failures raise a toast, first-load failures render
inline error states with Retry.

### Live updates (`src/features/realtime/RealtimeProvider.tsx`)

A WebSocket to `/api/v1/ws` (same origin, `ws`/`wss`) authenticates with
`{"type":"auth","token","organization_id"}` and waits for `{"type":"ready"}`. Events invalidate queries:
`incident` → incidents, dashboard, resources; `resource_status`/`check_state` → resources, checks, dashboard;
`metrics` → metrics and resource lists; `notification` → inbox and deliveries. The socket reconnects with
exponential backoff and pings every 25 s. While disconnected, live views poll (`useLiveInterval`, ~30 s); the
top bar shows "Live"/"Polling". The Logs page live tail sends `subscribe_logs` / `unsubscribe_logs` and appends
`log_tail` batches.

### Secrets

Check credentials, SNMP community strings, channel tokens and passwords are write-only: forms send them in
`secrets` and only show `has_secrets` / `secrets_configured` badges. Leaving a secret field blank when editing
keeps the stored value.

## Tests

```bash
npm test
```

MSW mocks the API at the network layer (`src/test/server.ts`, unhandled requests fail the test). Helpers:
`renderAuthed(ui, {route, path})` renders a component inside all providers with a restored session;
`renderApp(route)` (in `src/test/renderApp.tsx`) renders the full route table.
