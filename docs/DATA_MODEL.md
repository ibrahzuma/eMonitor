# Data model

## PostgreSQL (Alembic: `backend/migrations`, models: `backend/app/models`)

| Table | Purpose / key columns |
|---|---|
| `organizations` | tenant; `settings` (session idle, reopen window, agent timeout, SSL alert days, retention, quotas), `thresholds`, `monitoring_scope`, `incident_seq` |
| `users` | `email` (unique, case-insensitive), Argon2 `password_hash`, `is_superadmin`, TOTP (encrypted), lockout counters |
| `memberships` | user ↔ organization with `role` (`org_admin`, `it_admin`, `operator`, `viewer`) |
| `teams` | org teams with `member_ids` |
| `user_sessions` | hashed refresh tokens, `family_id` (reuse detection), expiry/rotation/revocation |
| `password_reset_tokens` | hashed single-use tokens |
| `api_keys` | `prefix` + SHA-256 of secret, role, scopes, expiry, revocation |
| `audit_logs` | actor, action, target, scrubbed details, IP, request id |
| `saved_searches` | per-user/shared log/resource/incident filters |
| `resource_groups` | folders (`parent_id`) |
| `resources` | every monitored thing: `kind`, name, environment, location, owner, team, group, `tags[]` (GIN), `custom_fields`, `attributes`, current `status` |
| `servers` | 1:1 server details: host/IP/OS, interval, agent timeout, per-server thresholds, monitored services, latest snapshot |
| `resource_dependencies` | directed dependency edges (cycle-checked) |
| `checks` | type, validated `config`, encrypted `secret_config_enc`, interval/timeout, thresholds, scheduling (`next_run_at`, `last_slot`) and evaluation state; partial index on due checks |
| `agents` | per-server agent credentials (hashed), previous secret + grace, status, version, last seen |
| `agent_enrollment_tokens` | hashed tokens, uses, expiry, defaults for new servers |
| `metric_states` | current threshold level per (server, metric[:instance]) with pending counter |
| `incidents` | number (per org), severity, status, `dedup_key` (**partial unique index on open incidents**), resource, assignee, evidence, lifecycle timestamps, escalation step |
| `incident_events` | timeline (created, acknowledged, comment, assigned, resolved, reopened, escalated …) |
| `alert_rules` / `alert_rule_states` | rule definitions; per-subject state machine (ok/pending/firing) |
| `notification_channels` | type, config, encrypted secrets, rate limit |
| `notification_policies` | routing (severity, teams), escalation steps, quiet hours, templates |
| `notification_deliveries` | transactional outbox + delivery log (unique `dedup_key`, attempts, backoff, status) |
| `in_app_notifications` | per-user inbox |
| `maintenance_windows` | one-off/recurring (RRULE subset), time zone, scope, suppression flags |
| `slos` | target, window, burn-rate thresholds, last status |

## ClickHouse (`backend/app/telemetry/schema.sql`, applied by `python -m app.cli clickhouse-migrate`)

| Table | Engine / partition / order | Content |
|---|---|---|
| `metrics` | MergeTree, `toYYYYMM(ts)`, `(org_id, resource_id, metric, instance, ts)`, row TTL `retention_days` | agent, SNMP, check and API metrics |
| `check_results` | ReplacingMergeTree(executed_at), `toYYYYMM(scheduled_at)`, `(org_id, check_id, scheduled_at)` | every slot incl. skipped; duplicates collapse |
| `logs` | MergeTree, `toYYYYMMDD(ts)`, `(org_id, ts, id)`, tokenbf index on `lower(message)`, bloom on `trace_id`, row TTL | log records |
| `events` | MergeTree, `toYYYYMM(ts)`, `(org_id, ts, id)`, TTL 400 d | status changes, incident activity |

Retention per tenant is stored on each row (`retention_days`, from organization settings at ingest time)
and enforced by ClickHouse TTL merges. All queries bind parameters server-side and filter by `org_id`.
