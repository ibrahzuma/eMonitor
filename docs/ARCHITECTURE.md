# eMonitor — Architecture

eMonitor is a multi-tenant monitoring platform for servers, websites/APIs, network devices,
services, databases and logs. This document describes the components, data stores, security
boundaries, and failure/recovery behaviour. It is the reference for contributors and operators.

## 1. Component overview

```text
                ┌──────────────────────────────── Ubuntu host(s) ───────────────────────────────┐
 Browser ──TLS──► Nginx ──► /            static React build (frontend/dist)                     │
                │        └► /api/v1/*   emonitor-api (uvicorn, FastAPI, N workers)              │
                │        └► /api/v1/ws  WebSocket (same API process)                           │
 Agents  ──TLS──►            /api/v1/agents/*  (enroll / metrics / logs / heartbeat)            │
 Syslog  ──UDP/TCP──► emonitor-syslog (controlled collector, registered sources only)          │
                │                                                                              │
                │  emonitor-scheduler  ── picks due checks from PostgreSQL (SKIP LOCKED) ──┐    │
                │                                                                          ▼    │
                │  Redis  ◄── Celery broker (queues: checks, notifications, maintenance)        │
                │        ◄── ingest stream (metrics/logs, bounded = backpressure)              │
                │        ◄── pub/sub for live events, rate-limit counters, caches              │
                │                                                                              │
                │  emonitor-worker (Celery)  ── runs probes, evaluates state, opens incidents,  │
                │                               sends notifications, evaluates alert rules      │
                │  emonitor-ingest            ── drains ingest stream, batch-writes ClickHouse, │
                │                               evaluates agent metric thresholds               │
                │                                                                              │
                │  PostgreSQL  — config, users, tenants, incidents, rules, audit (transactional) │
                │  ClickHouse  — metrics, check results, logs, events (high volume, TTL)         │
                └──────────────────────────────────────────────────────────────────────────────┘
```

| Service             | Process                                   | Scales by                          |
|---------------------|-------------------------------------------|------------------------------------|
| `emonitor-api`      | `uvicorn app.main:app`                    | more uvicorn workers / hosts       |
| `emonitor-scheduler`| `python -m app.workers.scheduler`         | safe to run >1 (row locking)       |
| `emonitor-worker`   | `celery -A app.workers.celery_app worker` | more worker processes / hosts      |
| `emonitor-beat`     | `celery -A app.workers.celery_app beat`   | exactly one                        |
| `emonitor-ingest`   | `python -m app.workers.ingest`            | more consumers (consumer group)    |
| `emonitor-syslog`   | `python -m app.workers.syslog_collector`  | one per listening address          |
| `emonitor-agent`    | on monitored Linux servers                | one per server                     |

No component requires Docker. All services are systemd units (see `deployment/systemd`).

## 2. Data stores

### PostgreSQL (transactional, source of truth for configuration)
Organizations, users, memberships/roles, teams, sessions, API keys, resources (servers,
websites, network devices, services, databases), checks, agents, enrollment tokens,
thresholds, incidents + timeline events, alert rules, notification channels/policies/
deliveries, maintenance windows, SLOs, saved searches, audit logs. Schema is managed only by
Alembic (`backend/migrations`). See `docs/DATA_MODEL.md`.

### ClickHouse (high volume, append-only, TTL-based retention)
| Table           | Content                                   | Partition          | ORDER BY                                  |
|-----------------|-------------------------------------------|--------------------|-------------------------------------------|
| `metrics`       | agent / SNMP numeric samples              | `toYYYYMM(ts)`     | `(org_id, resource_id, metric, ts)`       |
| `check_results` | every scheduled check outcome (incl. skipped) | `toYYYYMM(scheduled_at)` | `(org_id, check_id, scheduled_at)` |
| `logs`          | log records                               | `toYYYYMMDD(ts)`   | `(org_id, ts, id)` + token bloom index    |
| `events`        | status transitions, activity feed         | `toYYYYMM(ts)`     | `(org_id, ts)`                            |

Retention is enforced by table `TTL` plus per-tenant `retention_days` columns (row TTL).
All queries are parameterised through `clickhouse-connect` server-side binding (`{p:Type}`);
user input never becomes SQL text. Every read query is constrained by `org_id`,
`max_execution_time`, and a row `LIMIT`.

### Redis (operational, non-authoritative)
Celery broker/result backend, ingest stream (`emonitor:ingest`, capped with `MAXLEN` → 503
backpressure), pub/sub for live events (`emonitor:events:{org_id}`), rate limiting counters,
short-lived caches (threshold configs). Losing Redis loses only in-flight queue items; the
scheduler re-derives due work from PostgreSQL and agents re-send spooled telemetry.

## 3. Multi-tenancy and authorization

* Every tenant-owned row carries `organization_id`. Repositories/queries always filter on it;
  it is taken from the authenticated context, never from the request body.
* The request context (`app/core/deps.py::get_ctx`) resolves: principal (user session JWT or
  API key), active organization (`X-Organization-ID` header, validated against memberships),
  and the role in that organization. Super Administrators may act in any organization.
* Permissions are coarse capabilities (`resources:write`, `incidents:ack`, `users:manage`, …)
  mapped from roles in `app/core/permissions.py`; endpoints declare the capability they need
  via `require(Permission.X)`. The frontend hides controls, but the backend enforces.
* Cross-tenant references (e.g. attaching a check to a resource) are validated by loading the
  referenced row through the tenant-scoped query; foreign rows result in 404, not 403, to
  avoid existence disclosure.

| Role                     | Summary                                                         |
|--------------------------|-----------------------------------------------------------------|
| Super Administrator      | platform-wide: create orgs, manage any org, global settings     |
| Organization Administrator | everything inside one org incl. users, roles, API keys          |
| IT Administrator         | resources, checks, agents, rules, channels, maintenance         |
| Operator                 | view all, acknowledge/assign/resolve incidents, comment         |
| Read-Only Viewer         | view only                                                       |

## 4. Authentication

* Passwords: Argon2id (`argon2-cffi`), policy min length 12.
* Login returns a short-lived access JWT (default 15 min, HS256 with `SECRET_KEY`) in the body
  and a refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to
  `/api/v1/auth`. Refresh tokens are random 256-bit values stored hashed in `user_sessions`;
  each refresh rotates them and detects reuse (reuse revokes the session family).
* CSRF: cookie-authenticated endpoints (`/auth/refresh`, `/auth/logout`) require the
  `X-CSRF-Token` header to match the `emonitor_csrf` cookie (double-submit). All other API
  calls use the `Authorization: Bearer` header and are not CSRF-exposed.
* Idle session timeout (`session_idle_minutes`, per org) and absolute lifetime enforced on refresh.
* Optional TOTP 2FA (RFC 6238, `pyotp`); login then requires a second step with the code.
* Password reset: single-use, hashed, 30-minute token sent by email; responses never reveal
  whether an address exists.
* API keys: `emk_<prefix>_<secret>`; only SHA-256 of the secret is stored; scoped to one org
  and a role; shown once on creation; can expire and be revoked.
* Rate limits (Redis fixed window): login, password reset, 2FA, enrollment, API in general.

## 5. Monitoring pipeline

### 5.1 Checks (pull-based)
A **check** belongs to a resource and has `type` (`http`, `tcp`, `icmp`, `dns`, `tls`, `smtp`,
`ssh`, `postgres`, `mysql`, `redis`, `snmp`), JSON `config` validated by a per-type Pydantic
schema, `interval_seconds`, `timeout_seconds`, and `next_run_at`.

```text
scheduler loop (1s tick)
  BEGIN
  SELECT … FROM checks WHERE enabled AND next_run_at <= now()
       ORDER BY next_run_at LIMIT :batch FOR UPDATE SKIP LOCKED
  for each: slot = next_run_at; next_run_at = slot + interval (catch-up skips missed slots,
            recording them as 'skipped' so they count as UNKNOWN, never as UP)
  COMMIT → then enqueue celery run_check(check_id, slot)   (queue depth bounded)
worker run_check
  probe (network I/O, SSRF-guarded, hard timeout) → CheckOutcome
  write check_results row to ClickHouse (via ingest stream)
  BEGIN; SELECT check FOR UPDATE; ignore if slot <= last_slot (idempotent/duplicate);
         update consecutive_failures/successes, state; COMMIT
  state transition → incident engine + events + notifications
```

Because scheduling state lives in PostgreSQL, restarting the scheduler or workers loses
nothing: due checks are simply picked up on the next tick. A slot is processed at most once
for state purposes (`last_slot` guard), so Celery redelivery (`acks_late`) is harmless.

### 5.2 Agent telemetry (push-based)
The Linux agent (stdlib-only Python, `agent/`) reads `/proc`, `statvfs` and an allowlist of
systemd units every `interval` seconds and POSTs JSON batches to `/api/v1/agents/metrics`
with `Authorization: Agent <agent_id>.<secret>`. The API validates, pushes to the Redis ingest
stream and returns `202`; when the stream is above its high-water mark it returns `503` +
`Retry-After` and the agent keeps the batch in its bounded on-disk spool and retries with
exponential backoff + jitter. `emonitor-ingest` batch-inserts into ClickHouse (flush on
size or 1 s) and evaluates thresholds (CPU, memory, disk, …) against org/server overrides.
A periodic task marks servers whose agent missed `agent_timeout_seconds` as *Unreachable*.

The agent never executes commands sent by the server. The server can only change the
collection interval (bounded) via the heartbeat response; everything else is local config.

### 5.3 Health status
`healthy | warning | critical | unreachable | unknown | maintenance`. A resource's status is
the worst status of its checks and metric evaluations; `maintenance` overrides for display
while measurements continue. Status transitions are recorded as events.

### 5.4 Incident engine (`app/incidents/engine.py`)
* Each condition has a deterministic **dedup key**, e.g. `check:{check_id}`,
  `metric:{server_id}:cpu`, `rule:{rule_id}:{resource_id}`, `ssl:{check_id}:{threshold}`.
* A partial unique index `(organization_id, dedup_key) WHERE status <> 'resolved'` guarantees
  at most one open incident per condition, even under concurrent workers
  (`INSERT … ON CONFLICT DO NOTHING` + re-select).
* Repeated failures update `last_detected_at`, `occurrence_count`, evidence.
* Recovery auto-resolves (if the rule allows), recording a timeline event.
* A condition returning within `reopen_window` of resolution reopens the last incident instead
  of creating a new one (status `reopened`).
* Lifecycle: `triggered → acknowledged → investigating → resolved`, `resolved → reopened`.

### 5.5 Alert rules
Rules evaluated by a periodic Celery task on their `evaluation_interval`, using aggregate
queries over ClickHouse (`avg/max/min/p95` over a window) or PostgreSQL state:
`metric_threshold`, `consecutive_failures`, `response_time`, `ssl_expiry`, `log_pattern`,
`error_rate`, `missing_telemetry`, `agent_disconnected`, `composite` (AND/OR of other rules).
Each rule has severity, consecutive breaches required, recovery condition, cooldown,
maintenance suppression and a notification policy.

### 5.6 Notifications
Incident events (triggered, escalated, acknowledged, resolved) → notification policy →
routes by severity/team → channels (`email`, `telegram`, `webhook`, `in_app`).
Each delivery is a row in `notification_deliveries`, sent by a Celery task with retries
(exponential backoff, max attempts), deduplicated by `(incident, channel, event, step)`,
rate-limited per channel, silenced by quiet hours and maintenance windows (but still
logged as `suppressed`). Escalation steps fire if the incident is still unacknowledged after
the step delay. Channel secrets are encrypted at rest with Fernet (`ENCRYPTION_KEY`) and
never returned by the API (write-only fields; responses show `"configured": true`).
New providers implement `NotificationProvider.send()` and register in `providers/__init__.py`.

### 5.7 Maintenance windows
One-off or recurring (RRULE subset: daily/weekly/monthly, interval, weekdays), with time zone,
targets (resources, groups, or whole org). Active windows: suppress notifications per policy
and mark measurements `in_maintenance=1`. Measurements are never dropped; reports show
maintenance time separately from downtime.

## 6. Availability math (see `docs/METRICS.md`)
For a check over a period: `expected` slots = period / interval; each slot is UP, DOWN,
DEGRADED, UNKNOWN (no result, skipped, worker error) or MAINTENANCE.
`uptime % = UP+DEGRADED / (UP+DEGRADED+DOWN)` over *known, non-maintenance* slots;
`coverage % = known / expected`. UNKNOWN is reported separately and never counted as up.

## 7. Network safety (SSRF / unauthorized scanning)
`app/monitoring/netguard.py`:
* Every target hostname is resolved by the worker; **every** resolved address must pass:
  global deny list (loopback, link-local incl. `169.254.169.254`, multicast, reserved,
  unspecified, IPv6 ULA/link-local, `fd00:ec2::254`), unless explicitly listed in the
  organization's monitoring scope **and** permitted by the platform `ALLOW_PRIVATE_TARGETS`.
* Organization monitoring scope: allowed CIDRs and hostname suffixes. Targets outside the
  scope are rejected at configuration time (422) and again at execution time.
* Connections are made to the validated IP (resolver pinning) to defeat DNS rebinding;
  redirects are re-validated hop by hop; response body reads are size-capped.
* Webhook notification URLs pass the same guard.
* Ports for TCP checks are explicit; there is no port range / sweep feature.

## 8. Real-time updates
The API exposes `/api/v1/ws`. The client authenticates with the first message
(`{"type":"auth","token":…,"organization_id":…}`), never via the URL. Workers publish events
to Redis `emonitor:events:{org}`; each API process subscribes and forwards to the org's
sockets (status changes, incidents, live log tail when subscribed with filters).
The frontend invalidates TanStack Query caches on events, falling back to polling.

## 9. Failure modes & recovery

| Failure                         | Effect                                   | Recovery                                                    |
|---------------------------------|------------------------------------------|-------------------------------------------------------------|
| Scheduler down                  | no new checks dispatched                 | on restart picks due checks; missed slots recorded `skipped`|
| Worker crash mid-check          | Celery redelivers (`acks_late`)          | `last_slot` guard prevents double state transitions         |
| Redis down                      | API ingest returns 503; checks not queued| agents spool + retry; scheduler retries enqueue next tick    |
| ClickHouse down                 | ingest consumer cannot flush             | entries stay pending in the stream (XPENDING) and are retried; stream cap → 503 |
| PostgreSQL down                 | API 503, workers retry                   | standard; no telemetry loss while Redis stream has capacity  |
| Notification provider failing   | delivery retries with backoff            | marked `failed` after max attempts; visible in delivery log |
| Agent offline                   | server → unreachable after timeout       | agent flushes spool on reconnect                            |

All services handle SIGTERM gracefully (finish current batch/task, flush buffers).

## 10. Observability of the platform itself
* `GET /api/v1/health/live` (process up), `GET /api/v1/health/ready` (PG, Redis, ClickHouse).
* `GET /api/v1/system/status` (super admin): queue depths, ingest lag, scheduler heartbeat,
  worker heartbeats, failed deliveries.
* Structured JSON logs with `request_id` (`X-Request-ID` honoured/generated) and secret
  redaction filter.

## 11. Repository layout
```text
backend/   FastAPI app (app/), Alembic (migrations/), tests/
frontend/  React + Vite + TS + Tailwind
agent/     Linux agent (monitor_agent/), install scripts, systemd unit
deployment/ nginx, systemd, scripts (install, backup, restore), clickhouse schema
docs/      architecture, API, deployment, metrics, security, progress
```
