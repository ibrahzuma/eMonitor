# Security model

| Area | Control | Where |
|---|---|---|
| Passwords | Argon2id, min length 12 + complexity, hashed off the event loop; lockout after 10 failures (15 min) | `core/security.py`, `services/auth.py` |
| Sessions | 15-min access JWT in memory; refresh token in `HttpOnly; Secure; SameSite=Strict` cookie, hashed in DB, rotated on use, **reuse detection revokes the session family**; idle timeout per org; absolute lifetime | `services/auth.py` |
| CSRF | cookie-authenticated endpoints (`/auth/refresh`, `/auth/logout`) need `X-CSRF-Token` = `emonitor_csrf` cookie; everything else uses bearer tokens | `api/v1/auth.py` |
| 2FA | optional TOTP (RFC 6238); secret encrypted at rest | `api/v1/auth.py` |
| Password reset | single-use, 30-min, hashed token; identical response for unknown emails; all sessions revoked | `services/auth.py` |
| API keys | `emk_<prefix>_<secret>`, only SHA-256 stored, shown once, role + optional scope restriction, expiry, revocation, bound to one org | `core/deps.py` |
| RBAC | permissions derived from role per org; every endpoint declares `require(Permission.X)`; cannot grant roles above your own; last org admin protected | `core/permissions.py` |
| Tenant isolation | org from authenticated context only; all queries filter `organization_id`; foreign IDs → 404; cross-tenant references rejected | tests: `tests/test_tenancy.py` |
| Rate limiting | Redis fixed window (login, MFA, reset, enrollment, global API, per-agent) + nginx `limit_req` | `core/ratelimit.py` |
| SSRF / scanning | per-org monitoring scope; permanent deny of metadata/link-local/multicast; private ranges only if authorized; DNS-pinned connections; IP-literal hosts and every redirect hop re-validated; webhooks guarded the same way; no port sweeps | `monitoring/netguard.py`, tests `test_netguard.py`, `test_probes.py` |
| Secrets at rest | check credentials, SNMP communities, channel tokens encrypted with Fernet (`EMONITOR_ENCRYPTION_KEY`); write-only in the API; scrubbed from audit logs | `core/security.py`, `services/audit.py` |
| SQL injection | SQLAlchemy parameters for PostgreSQL; ClickHouse server-side bound parameters — no user text in SQL | `telemetry/store.py`, `test_logs.py` |
| Read-only DB checks | queries must be single read-only statements and run inside read-only transactions with statement timeouts; use a least-privileged monitoring account | `monitoring/check_configs.py`, `probes/db.py` |
| XSS | React escaping; strict CSP in nginx; no `dangerouslySetInnerHTML` | `deployment/nginx/emonitor.conf` |
| CSV injection | exported cells starting with `= + - @` are prefixed with `'` | reports, logs, incidents exports |
| Templates | notification templates rendered in a Jinja2 sandbox, fall back to defaults on error | `notifications/templates.py` |
| Logging | JSON logs with request IDs; redaction of passwords, tokens, API keys, agent secrets, URL credentials | `core/logging.py` |
| Agent | stdlib only; HTTPS with verification; per-agent secret (hashed server-side) with rotation + grace period + revocation; never executes server-supplied commands; only allowlisted `/proc` reads and `systemctl is-active` for locally configured units; hardened systemd unit (no capabilities, read-only FS) | `agent/` |
| Syslog | accepted only from registered source IPs, mapped to their tenant | `workers/syslog_collector.py` |
| Infrastructure | services as unprivileged `emonitor` user with systemd sandboxing; DB/Redis/ClickHouse on loopback with passwords; least-privilege PostgreSQL app role | `deployment/` |
| Audit | sensitive actions (auth, users, keys, org settings, resources, rules, channels, maintenance, agents) recorded with actor, IP and request ID | `services/audit.py` |
| Dependencies | `pip-audit` (Python) and `npm audit` (frontend) — both clean at release time | `docs/PROGRESS.md` |

## Reporting
Report vulnerabilities privately to the maintainers; do not open public issues for security problems.

## Operator checklist
- [ ] Unique `EMONITOR_SECRET_KEY` and `EMONITOR_ENCRYPTION_KEY`; back the encryption key up separately.
- [ ] HTTPS with HSTS (certbot); `EMONITOR_COOKIE_SECURE=true`.
- [ ] Restrict SSH; keep 5432/6379/8123/9000 closed.
- [ ] Set `EMONITOR_PROBE_BLOCKED_CIDRS` to the platform's own networks.
- [ ] Review each organization's monitoring scope; prefer `allow_public=false` with explicit hostnames for
      restricted tenants.
- [ ] Enable 2FA for administrators.
- [ ] Off-host, encrypted backups; quarterly restore test.
