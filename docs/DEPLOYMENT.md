# Deployment guide — Ubuntu Server (native, no Docker)

Tested target: Ubuntu Server 22.04 / 24.04 LTS, x86_64. Minimum for a small installation
(≈100 resources): 4 vCPU, 8 GB RAM, 100 GB SSD. ClickHouse benefits most from extra RAM and disk.

> **Verification status.** The installer and unit files were written for Ubuntu and syntax-checked
> (`bash -n`), but this release was developed on Windows: the scripts have **not yet been executed on a
> real Ubuntu host**. Do a staging install first and report problems. See `docs/PROGRESS.md`.

## 1. Components

| Service | Unit | Notes |
|---|---|---|
| API (FastAPI, uvicorn, 4 workers) | `emonitor-api.service` | listens on 127.0.0.1:8000 behind nginx |
| Scheduler | `emonitor-scheduler.service` | dispatches due checks; >1 instance is safe |
| Workers | `emonitor-worker@{checks,notifications,rules,maintenance}.service` | Celery; scale per queue |
| Periodic tasks | `emonitor-beat.service` | run **exactly one** |
| Telemetry ingest | `emonitor-ingest.service` | Redis stream → ClickHouse batches |
| Syslog collector | `emonitor-syslog.service` | optional; UDP/TCP 514 |
| All of the above | `emonitor.target` | `systemctl restart emonitor.target` |

## 2. Automated install

```bash
git clone <repo> /root/emonitor-src && cd /root/emonitor-src
sudo ./deployment/scripts/install.sh --domain monitor.example.com --admin-email you@example.com \
     --org-name "Acme Corp" --org-slug acme
```

The installer (idempotent):
1. installs `postgresql`, `redis-server`, `nginx`, Python venv tooling, Node 22 (build only), ClickHouse (official repo);
2. creates the `emonitor` system user, `/opt/emonitor`, `/etc/emonitor`, `/var/lib/emonitor`, `/var/backups/emonitor`;
3. generates `/etc/emonitor/emonitor.env` (mode 0640 root:emonitor) from `.env.example` with random secrets;
4. creates PostgreSQL roles **`emonitor_owner`** (owns schema, runs migrations) and **`emonitor_app`** (DML only, used by services);
5. configures Redis (localhost, password, AOF, `noeviction`, dangerous commands disabled) and ClickHouse (localhost, dedicated user limited to the `emonitor` DB);
6. installs the backend into a venv, builds the frontend, runs `alembic upgrade head` and `app.cli clickhouse-migrate`;
7. installs systemd units, journald limits, logrotate, nginx site, UFW rules (SSH + 80/443), and a daily backup cron;
8. prompts for the first Super Administrator password (`app.cli bootstrap`).

## 3. Manual install (what the script does, step by step)

```bash
sudo apt-get install -y python3 python3-venv python3-dev build-essential libpq-dev postgresql redis-server nginx iputils-ping
# ClickHouse: https://clickhouse.com/docs/install (deb repo), then install clickhouse-server clickhouse-client
sudo useradd --system --home /opt/emonitor --shell /usr/sbin/nologin emonitor
sudo install -d -o root -g emonitor -m 0750 /etc/emonitor
sudo cp .env.example /etc/emonitor/emonitor.env   # edit every CHANGE_ME value
sudo python3 -m venv /opt/emonitor/venv
sudo rsync -a backend/ /opt/emonitor/backend/
sudo /opt/emonitor/venv/bin/pip install -r /opt/emonitor/backend/requirements.txt
```

### PostgreSQL
```sql
CREATE ROLE emonitor_owner LOGIN PASSWORD '...';
CREATE ROLE emonitor_app   LOGIN PASSWORD '...';
CREATE DATABASE emonitor OWNER emonitor_owner;
\c emonitor
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO emonitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emonitor_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO emonitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emonitor_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO emonitor_app;
```
`EMONITOR_DATABASE_URL` uses `emonitor_app`; `EMONITOR_MIGRATION_DATABASE_URL` uses `emonitor_owner` (only read by Alembic).

### Migrations
```bash
cd /opt/emonitor/backend
sudo -u emonitor bash -c 'set -a; source /etc/emonitor/emonitor.env; set +a; /opt/emonitor/venv/bin/alembic upgrade head'
sudo -u emonitor bash -c 'set -a; source /etc/emonitor/emonitor.env; set +a; /opt/emonitor/venv/bin/python -m app.cli clickhouse-migrate'
sudo -u emonitor bash -c 'set -a; source /etc/emonitor/emonitor.env; set +a; /opt/emonitor/venv/bin/python -m app.cli bootstrap --email you@example.com --org-name "Acme" --org-slug acme'
```
Never change schemas by hand: create a new Alembic revision (`alembic revision --autogenerate -m "..."`), review it, commit it.

### Redis / ClickHouse
Copy `deployment/redis/emonitor.conf` (set `requirepass`) and include it from `/etc/redis/redis.conf`.
Copy `deployment/clickhouse/emonitor-listen.xml` to `config.d/` and `emonitor-user.xml` to `users.d/`
(replace `__PASSWORD_SHA256__` with `printf '%s' "$PASSWORD" | sha256sum`).

### Frontend
```bash
cd frontend && npm ci && npm run build && sudo rsync -a --delete dist/ /opt/emonitor/frontend/dist/
```

### systemd
```bash
sudo cp deployment/systemd/*.service deployment/systemd/*.target /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now emonitor.target
sudo systemctl enable --now emonitor-syslog   # optional
```
Worker concurrency: `sudo systemctl edit emonitor-worker@checks` and override `ExecStart` with a different
`--concurrency`. Add more worker hosts by deploying the same code + env file and starting only
`emonitor-worker@checks` there (they connect to the same Redis/PostgreSQL).

## 4. Nginx and HTTPS
```bash
sudo cp deployment/nginx/emonitor-proxy.conf /etc/nginx/snippets/
sudo sed "s/monitor.example.com/YOUR.DOMAIN/g" deployment/nginx/emonitor.conf | sudo tee /etc/nginx/sites-available/emonitor
sudo ln -s /etc/nginx/sites-available/emonitor /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d YOUR.DOMAIN
```
The site config sets HSTS, CSP, frame/sniffing protections, auth-endpoint rate limits, WebSocket upgrade
for `/api/v1/ws`, and overwrites `X-Forwarded-For` so clients cannot spoof their IP (the API trusts it only
from `EMONITOR_TRUSTED_PROXIES`).

## 5. Firewall recommendations
* Public: 443 (and 80 for ACME/redirect). SSH restricted to admin networks.
* Never expose PostgreSQL (5432), Redis (6379), ClickHouse (8123/9000) — all bind to loopback.
* Syslog 514/udp+tcp only from device management networks: `ufw allow from 10.0.0.0/8 to any port 514`.
* Outbound from workers: whatever your monitoring scope requires. Block the platform's own internal
  networks from probes with `EMONITOR_PROBE_BLOCKED_CIDRS`.

## 6. Configuration reference
All settings are environment variables with prefix `EMONITOR_` (see `.env.example` and
`backend/app/core/config.py`). Production refuses to start with the default secret key, a missing
`EMONITOR_ENCRYPTION_KEY`, insecure cookies, or dev inline workers enabled.

## 7. Backups & restore
* Daily cron runs `/usr/local/sbin/emonitor-backup` → `/var/backups/emonitor/<UTC timestamp>/`:
  `postgres.dump` (pg_dump custom format), ClickHouse native `BACKUP DATABASE` (or Native-format export),
  a copy of `/etc/emonitor` (**contains the encryption key** — store backups encrypted and off-host).
  Retention: 14 days (`EMONITOR_BACKUP_KEEP_DAYS`).
* Copy backups off the host (e.g. `restic`/`rclone` to object storage).
* Restore: `sudo emonitor-restore /var/backups/emonitor/<TS> [--with-config]` — verifies the checksum, stops
  services, restores PostgreSQL into a fresh DB (old one kept as `emonitor_restore_old`), restores ClickHouse,
  restarts. **Test restores regularly on a staging host.**
* Losing `EMONITOR_ENCRYPTION_KEY` makes stored channel/check secrets unreadable (they must be re-entered).

## 8. Log rotation
Services log JSON to journald; `deployment/journald/emonitor.conf` caps the journal at 2 GB / 30 days.
`deployment/logrotate/emonitor` rotates the backup log. View logs: `journalctl -u emonitor-api -f`.

## 9. Upgrade & rollback
Upgrade: `sudo ./deployment/scripts/upgrade.sh` from the new source tree. It backs up, snapshots the current
release to `/opt/emonitor/releases/<TS>.tar.gz`, stops background services, deploys, migrates, restarts and
checks `/health/ready`.

Rollback:
1. `sudo systemctl stop emonitor.target`
2. `sudo tar -C /opt/emonitor -xzf /opt/emonitor/releases/<TS>.tar.gz`
3. If the failed release ran migrations: either `alembic downgrade <previous_revision>` (as owner role) or
   `emonitor-restore /var/backups/emonitor/<pre-upgrade TS>` (loses data written since the backup).
4. `sudo systemctl start emonitor.target`

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| UI loads, API 502 | `systemctl status emonitor-api`, `journalctl -u emonitor-api -n 100` |
| `/api/v1/health/ready` 503 | the JSON body names the failing dependency (postgres/redis/clickhouse) |
| Checks never run / stale "last run" | `systemctl status emonitor-scheduler emonitor-worker@checks`; super-admin **System Settings → Platform status** shows heartbeats and queue depths |
| Agents get HTTP 503 | ingest stream saturated: is `emonitor-ingest` running? Is ClickHouse healthy? (`clickhouse-client -q 'SELECT 1'`) |
| Notifications not sent | Notifications → Delivery log shows status/last error; check `emonitor-worker@notifications` and SMTP/Telegram reachability |
| Check result "blocked by monitoring scope policy" | target is outside the org's authorized scope: Settings → Monitoring scope |
| ICMP checks "ping utility not available" / permission | install `iputils-ping`; unit grants `CAP_NET_RAW` |
| "Unable to decrypt stored secret" | `EMONITOR_ENCRYPTION_KEY` changed — restore the original key |
| Login says account locked | 10 failed attempts lock for 15 min; an admin can reset the password |
