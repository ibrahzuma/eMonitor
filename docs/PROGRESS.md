# Progress checklist

Status as of 2026-10-21. "Verified" means exercised by automated tests that were actually executed, or by a
live run described below. Items marked **not verified** exist in code but were not executed in this
environment.

## Test results (executed)
| Suite | Result | Notes |
|---|---|---|
| Backend `pytest` | **134 passed** | real PostgreSQL 17.6 (schema created by Alembic migrations every run), fakeredis, in-memory telemetry store |
| Agent `pytest` | **12 passed** | parsers, collector on a fake `/proc`, spool bounds, log rotation, delivery/backoff against a local HTTP server |
| Frontend `vitest` | **71 passed** (20 files) | msw-mocked API |
| Frontend typecheck / lint / build | pass | `tsc --noEmit`, ESLint (no `any`), Vite production build |
| Backend lint (`ruff`, incl. bandit rules) | pass | reviewed exceptions documented in `pyproject.toml` |
| `pip-audit` / `npm audit` | 0 known vulnerabilities | after upgrading react-router 7, vite 6.4, vitest 5 |
| Alembic | upgrade → downgrade → upgrade, `alembic check` clean | |
| Live dev run | real HTTP/TLS/DNS/TCP checks against public sites; agent enrolled and reported metrics to the running API | single-process dev mode |
| Load test | see `docs/LOAD_TESTING.md` | laptop, API path only |

## Phases
### 1. Architecture & planning — done
- [x] Architecture (`ARCHITECTURE.md`), data model (`DATA_MODEL.md`), API contracts (`API.md` + OpenAPI), security boundaries (`SECURITY.md`), metric definitions (`METRICS.md`)

### 2. Foundation — done
- [x] FastAPI app, settings, structured logging with redaction, error envelope, request IDs, security headers
- [x] SQLAlchemy 2 async models + Alembic migration
- [x] Auth: Argon2, JWT + rotating refresh cookies with reuse detection, CSRF, TOTP 2FA, password reset, lockout, sessions
- [x] Organizations, memberships, 5 roles, permission enforcement, tenant isolation, API keys with scopes, audit log, rate limiting

### 3. Core monitoring — done
- [x] Resource inventory (servers, websites/APIs, network devices, services, databases, applications), groups, tags, custom fields, dependencies (cycle-checked), bulk import with dry run
- [x] Checks: HTTP(S) (status, keyword, headers, JSON assertions, redirects, auth, timing, TLS cert), TCP, ICMP, DNS, TLS, SMTP (+STARTTLS), SSH, PostgreSQL, MySQL/MariaDB, Redis, SNMP v1/v2c/v3 (system + interface counters)
- [x] SSRF guard with org monitoring scope, DNS pinning, redirect and IP-literal validation
- [x] Durable scheduler (row-locking, missed slots recorded as unknown), Celery workers, idempotent result processing
- [x] Linux agent (stdlib), enrollment/rotation/revocation, spool + backoff, log tailing, install/uninstall, systemd unit
- [x] Metric ingestion with backpressure (Redis stream → ClickHouse batches), threshold evaluation, agent liveness

### 4. Logs, incidents, alerts — done
- [x] ClickHouse schema (partitioning, sort keys, TTL, token/bloom indexes), parameterized queries, log search/filters/facets/histogram/cursor pagination/export, saved searches, live tail, HTTP ingestion, quotas
- [x] Controlled syslog collector (registered sources only)
- [x] Incident engine: dedup (unique index), auto-resolve, reopen window, lifecycle, comments, assignment, bulk actions, export, grouping by resource
- [x] Alert rules: metric threshold, consecutive failures, website down, response time, SSL expiry, log pattern, error rate, missing telemetry, agent disconnected, composite; consecutive breaches, recovery, cooldown, maintenance suppression, preview
- [x] Notifications: email, Telegram, webhook (HMAC-signed), in-app; routing by severity/team; escalation; retries with backoff; delivery log; dedup; per-channel rate limit; quiet hours; sandboxed templates; encrypted secrets
- [x] Maintenance windows: one-off/recurring with time zones (DST-safe), scopes, notification/incident suppression, automatic expiry, telemetry kept

### 5. Dashboard & reporting — done
- [x] Overview, server/website/device/service detail pages, historical charts (15m–30d), compare servers, incident screens, WebSocket live updates with polling fallback, dark/light themes, responsive layout
- [x] Reports (availability, website uptime, service availability, incidents with MTTD/MTTA/MTTR, alert volume, utilization, capacity, SSL, log error rates, SLA) as JSON/CSV/PDF; SLOs with error budgets and burn-rate alerts

### 6. Hardening & deployment — partially verified
- [x] Native Ubuntu installer, systemd units (hardened), nginx (TLS, CSP, WebSocket), Redis/ClickHouse configs, backup/restore/upgrade scripts, log rotation, firewall guidance
- [x] Security checks (lint/bandit rules, dependency audits), failure handling fixed from load testing
- [ ] **Not verified:** installer, systemd units, nginx config, backup/restore and upgrade scripts have not been executed on Ubuntu (development host was Windows; scripts pass `bash -n` only)
- [ ] **Not verified:** ClickHouse store (`ClickHouseStore`) has not run against a real ClickHouse server — tests use an in-memory store with the same semantics; SQL generation and parameterization are unit-tested. Run the suite of smoke checks in `DEPLOYMENT.md` on staging first.
- [ ] **Not verified:** Celery worker/beat processes and the `emonitor-ingest` consumer loop as separate services (their task functions and `process_entries` are tested directly)
- [ ] **Not verified:** ICMP/SNMP/PostgreSQL/MySQL/Redis probes against real targets (parsers, config validation and error paths are tested; SNMP needs a device or `snmpd`)
- [ ] **Not verified:** Telegram/SMTP against real services (providers tested with mocked transports; webhook tested end-to-end locally)
- [ ] Production-scale load test on Ubuntu hardware (see `LOAD_TESTING.md`)

## Known limitations / follow-ups
* Windows server monitoring: collector interface exists; Windows collector not implemented.
* SMS and other notification providers: add a `NotificationProvider` subclass (framework in place).
* Live log tail polls ClickHouse every 2 s per subscribed socket and filters on event timestamp (late-arriving
  logs older than the poll window are not streamed, but are searchable).
* Dashboard widgets are fixed (filterable by environment/range), not user-rearrangeable.
* Database TLS hostname verification is not available because probes connect to the pinned IP (encryption is
  still used with `tls=require/prefer`).
* Clearing a single stored secret from the UI is not possible (blank = keep); use the API with an empty string.
