#!/usr/bin/env bash
# eMonitor installer for a SHARED Ubuntu host that already runs other applications.
#
# Differences from install.sh (which assumes a dedicated server):
#   * never restarts or reconfigures existing services (system Redis, PostgreSQL, nginx are only extended;
#     nginx is reloaded only after `nginx -t` passes; needrestart is kept in list-only mode)
#   * runs a dedicated Redis instance (emonitor-redis.service, 127.0.0.1:6380) instead of touching system Redis
#   * does not change the firewall and does not build the frontend on the server
#     (upload a prebuilt frontend/dist to $SRC_DIR/frontend/dist beforehand)
#   * ClickHouse memory is capped so co-hosted apps keep their RAM
#
# Usage (as root, from a checkout of the repository on the server):
#   EMONITOR_ADMIN_PASSWORD='...' ./deployment/scripts/install-shared.sh --domain monitor.example.com \
#       --admin-email admin@example.com [--org-name "Main"] [--org-slug main]
set -euo pipefail

DOMAIN=""; ADMIN_EMAIL=""; ORG_NAME="Main Organization"; ORG_SLUG="main"
APP_DIR=/opt/emonitor; ETC_DIR=/etc/emonitor; ENV_FILE=$ETC_DIR/emonitor.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --org-name) ORG_NAME="$2"; shift 2 ;;
    --org-slug) ORG_SLUG="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ -n "$DOMAIN" && -n "$ADMIN_EMAIL" ]] || { echo "--domain and --admin-email are required"; exit 2; }
[[ -f "$SRC_DIR/frontend/dist/index.html" ]] || { echo "missing prebuilt frontend/dist (build it locally and upload)"; exit 2; }

export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
log() { echo -e "\033[1;34m==>\033[0m $*"; }
rand() { python3 -c "import secrets; print(secrets.token_urlsafe(${1:-32}))"; }
as_emonitor() { sudo -u emonitor bash -c 'set -a; source "$0"; set +a; cd /opt/emonitor/backend; exec "$@"' "$ENV_FILE" "$@"; }

log "Packages (install only — no upgrades, no service restarts)"
apt-get update -q >/dev/null
apt-get install -y -q --no-upgrade python3-venv python3-dev build-essential libpq-dev iputils-ping rsync \
  curl gnupg ca-certificates certbot >/dev/null
if ! command -v clickhouse-server >/dev/null; then
  log "Installing ClickHouse"
  curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' | gpg --dearmor --yes -o /usr/share/keyrings/clickhouse-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg] https://packages.clickhouse.com/deb stable main" \
    > /etc/apt/sources.list.d/clickhouse.list
  apt-get update -q -o Dir::Etc::sourcelist=sources.list.d/clickhouse.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null
  apt-get install -y -q clickhouse-server clickhouse-client >/dev/null
fi

log "Service account and directories"
id emonitor >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin emonitor
install -d -o root -g emonitor -m 0750 "$ETC_DIR"
install -d -o emonitor -g emonitor -m 0750 /var/lib/emonitor
install -d -o root -g root -m 0711 /var/backups/emonitor
install -d -o redis -g redis -m 0750 /var/lib/emonitor-redis
install -d -m 0755 "$APP_DIR" "$APP_DIR/frontend"

if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating $ENV_FILE"
  PG_APP_PW=$(rand 24); PG_OWNER_PW=$(rand 24); REDIS_PW=$(rand 24); CH_PW=$(rand 24); CH_ADMIN_PW=$(rand 24)
  FERNET=$(python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())")
  sed -e "s|^EMONITOR_PUBLIC_BASE_URL=.*|EMONITOR_PUBLIC_BASE_URL=https://$DOMAIN|" \
      -e "s|^EMONITOR_CORS_ORIGINS=.*|EMONITOR_CORS_ORIGINS=https://$DOMAIN|" \
      -e "s|^EMONITOR_SECRET_KEY=.*|EMONITOR_SECRET_KEY=$(rand 48)|" \
      -e "s|^EMONITOR_ENCRYPTION_KEY=.*|EMONITOR_ENCRYPTION_KEY=$FERNET|" \
      -e "s|^EMONITOR_DATABASE_URL=.*|EMONITOR_DATABASE_URL=postgresql+asyncpg://emonitor_app:$PG_APP_PW@127.0.0.1:5432/emonitor|" \
      -e "s|^EMONITOR_REDIS_URL=.*|EMONITOR_REDIS_URL=redis://:$REDIS_PW@127.0.0.1:6380/0|" \
      -e "s|^EMONITOR_CLICKHOUSE_PASSWORD=.*|EMONITOR_CLICKHOUSE_PASSWORD=$CH_PW|" \
      -e "s|^EMONITOR_SMTP_HOST=.*|# EMONITOR_SMTP_HOST=smtp.example.com|" \
      -e "s|^EMONITOR_SMTP_USERNAME=.*|# EMONITOR_SMTP_USERNAME=|" \
      -e "s|^EMONITOR_SMTP_PASSWORD=.*|# EMONITOR_SMTP_PASSWORD=|" \
      "$SRC_DIR/.env.example" > "$ENV_FILE"
  {
    echo "EMONITOR_MIGRATION_DATABASE_URL=postgresql+asyncpg://emonitor_owner:$PG_OWNER_PW@127.0.0.1:5432/emonitor"
    echo "CLICKHOUSE_ADMIN_USER=default"
    echo "CLICKHOUSE_ADMIN_PASSWORD=$CH_ADMIN_PW"
  } >> "$ENV_FILE"
  chown root:emonitor "$ENV_FILE"; chmod 0640 "$ENV_FILE"
fi
set -a; source "$ENV_FILE"; set +a
PG_APP_PW=$(sed -E 's|.*://emonitor_app:([^@]+)@.*|\1|' <<<"$EMONITOR_DATABASE_URL")
PG_OWNER_PW=$(sed -E 's|.*://emonitor_owner:([^@]+)@.*|\1|' <<<"$EMONITOR_MIGRATION_DATABASE_URL")
REDIS_PW=$(sed -E 's|redis://:([^@]+)@.*|\1|' <<<"$EMONITOR_REDIS_URL")

log "Dedicated Redis instance on 127.0.0.1:6380 (system Redis untouched)"
cat > "$ETC_DIR/redis.conf" <<EOF
bind 127.0.0.1
protected-mode yes
port 6380
dir /var/lib/emonitor-redis
requirepass $REDIS_PW
appendonly yes
appendfsync everysec
maxmemory 512mb
maxmemory-policy noeviction
daemonize no
supervised systemd
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command CONFIG ""
rename-command DEBUG ""
EOF
chown root:redis "$ETC_DIR/redis.conf"; chmod 0640 "$ETC_DIR/redis.conf"
cat > /etc/systemd/system/emonitor-redis.service <<'EOF'
[Unit]
Description=Redis instance for eMonitor (127.0.0.1:6380)
After=network.target

[Service]
Type=notify
User=redis
Group=redis
ExecStart=/usr/bin/redis-server /etc/emonitor/redis.conf
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/emonitor-redis
PrivateTmp=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now emonitor-redis >/dev/null
for _ in $(seq 1 20); do redis-cli -p 6380 -a "$REDIS_PW" --no-auth-warning ping 2>/dev/null | grep -q PONG && break; sleep 1; done

log "PostgreSQL: dedicated database and roles (existing databases untouched)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='emonitor_owner') THEN CREATE ROLE emonitor_owner LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='emonitor_app') THEN CREATE ROLE emonitor_app LOGIN; END IF;
END \$\$;
ALTER ROLE emonitor_owner PASSWORD '$PG_OWNER_PW';
ALTER ROLE emonitor_app PASSWORD '$PG_APP_PW';
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='emonitor'" | grep -q 1 || \
  sudo -u postgres createdb -O emonitor_owner emonitor
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d emonitor <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO emonitor_owner;
GRANT USAGE ON SCHEMA public TO emonitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emonitor_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO emonitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emonitor_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO emonitor_app;
SQL

log "ClickHouse: loopback only, memory capped, passwords set"
install -m 0640 -o clickhouse -g clickhouse "$SRC_DIR/deployment/clickhouse/emonitor-listen.xml" \
  /etc/clickhouse-server/config.d/emonitor-listen.xml
cat > /etc/clickhouse-server/config.d/emonitor-memory.xml <<'EOF'
<clickhouse>
    <max_server_memory_usage_to_ram_ratio>0.25</max_server_memory_usage_to_ram_ratio>
    <mark_cache_size>268435456</mark_cache_size>
</clickhouse>
EOF
CH_HASH=$(printf '%s' "$EMONITOR_CLICKHOUSE_PASSWORD" | sha256sum | cut -d' ' -f1)
sed "s|__PASSWORD_SHA256__|$CH_HASH|" "$SRC_DIR/deployment/clickhouse/emonitor-user.xml" \
  > /etc/clickhouse-server/users.d/emonitor-user.xml
CH_ADMIN_HASH=$(printf '%s' "$CLICKHOUSE_ADMIN_PASSWORD" | sha256sum | cut -d' ' -f1)
cat > /etc/clickhouse-server/users.d/default-password.xml <<EOF
<clickhouse><users><default>
  <password remove="1"/>
  <password_sha256_hex>$CH_ADMIN_HASH</password_sha256_hex>
  <networks replace="1"><ip>127.0.0.1</ip><ip>::1</ip></networks>
</default></users></clickhouse>
EOF
chown clickhouse:clickhouse /etc/clickhouse-server/config.d/emonitor-*.xml /etc/clickhouse-server/users.d/*.xml
chmod 0640 /etc/clickhouse-server/users.d/*.xml
systemctl enable clickhouse-server >/dev/null
systemctl restart clickhouse-server
for _ in $(seq 1 60); do
  clickhouse-client --user emonitor --password "$EMONITOR_CLICKHOUSE_PASSWORD" -q "SELECT 1" >/dev/null 2>&1 && break; sleep 1
done

log "Application code"
rsync -a --delete --exclude '.venv' --exclude '__pycache__' --exclude 'tests' "$SRC_DIR/backend/" "$APP_DIR/backend/"
rsync -a --delete --exclude '__pycache__' --exclude 'tests' "$SRC_DIR/agent/" "$APP_DIR/agent/"
rsync -a --delete "$SRC_DIR/frontend/dist/" "$APP_DIR/frontend/dist/"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip wheel
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
chown -R root:root "$APP_DIR"; chmod -R a+rX "$APP_DIR"

log "Migrations"
as_emonitor "$APP_DIR/venv/bin/alembic" upgrade head
as_emonitor "$APP_DIR/venv/bin/python" -m app.cli clickhouse-migrate
if [[ -n "${EMONITOR_ADMIN_PASSWORD:-}" ]]; then
  sudo -u emonitor env EMONITOR_BOOTSTRAP_PASSWORD="$EMONITOR_ADMIN_PASSWORD" bash -c \
    'set -a; source "$0"; set +a; cd /opt/emonitor/backend; exec /opt/emonitor/venv/bin/python -m app.cli bootstrap --email "$1" --org-name "$2" --org-slug "$3"' \
    "$ENV_FILE" "$ADMIN_EMAIL" "$ORG_NAME" "$ORG_SLUG"
fi

log "systemd units (sized for a shared 4-core host)"
for f in "$SRC_DIR"/deployment/systemd/*.service "$SRC_DIR"/deployment/systemd/*.target; do
  sed -e 's/redis-server.service/emonitor-redis.service/g' "$f" > "/etc/systemd/system/$(basename "$f")"
done
sed -i 's/--workers 4/--workers 2/' /etc/systemd/system/emonitor-api.service
sed -i 's/--concurrency=8/--concurrency=4/' /etc/systemd/system/emonitor-worker@.service
install -d /etc/systemd/journald.conf.d
install -m 0644 "$SRC_DIR/deployment/journald/emonitor.conf" /etc/systemd/journald.conf.d/emonitor.conf
install -m 0644 "$SRC_DIR/deployment/logrotate/emonitor" /etc/logrotate.d/emonitor
systemctl daemon-reload
systemctl enable emonitor.target >/dev/null
systemctl restart emonitor.target

log "nginx site for $DOMAIN (other sites untouched)"
install -d /var/www/letsencrypt
install -m 0644 "$SRC_DIR/deployment/nginx/emonitor-proxy.conf" /etc/nginx/snippets/emonitor-proxy.conf
if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  cat > /etc/nginx/sites-available/emonitor <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 404; }
}
EOF
  ln -sf /etc/nginx/sites-available/emonitor /etc/nginx/sites-enabled/emonitor
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email
fi
sed -e "s/monitor.example.com/$DOMAIN/g" \
    -e 's/\$connection_upgrade/$emonitor_connection_upgrade/g' \
    "$SRC_DIR/deployment/nginx/emonitor.conf" > /etc/nginx/sites-available/emonitor
ln -sf /etc/nginx/sites-available/emonitor /etc/nginx/sites-enabled/emonitor
nginx -t && systemctl reload nginx

log "Backups (daily 02:30)"
install -m 0750 "$SRC_DIR/deployment/backup/backup.sh" /usr/local/sbin/emonitor-backup
install -m 0750 "$SRC_DIR/deployment/backup/restore.sh" /usr/local/sbin/emonitor-restore
echo "30 2 * * * root /usr/local/sbin/emonitor-backup >> /var/log/emonitor-backup.log 2>&1" > /etc/cron.d/emonitor-backup

sleep 3
curl -fsS http://127.0.0.1:8000/api/v1/health/ready && echo
log "Done: https://$DOMAIN"
