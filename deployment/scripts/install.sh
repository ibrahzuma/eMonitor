#!/usr/bin/env bash
# eMonitor native installer for Ubuntu Server 22.04 / 24.04 (no Docker).
#
# Usage (as root, from the repository root):
#   sudo ./deployment/scripts/install.sh --domain monitor.example.com --admin-email admin@example.com
#
# Idempotent: safe to re-run. Generated secrets are written once to /etc/emonitor/emonitor.env and
# never printed except the PostgreSQL/Redis/ClickHouse passwords which live only in that file.
set -euo pipefail

DOMAIN=""
ADMIN_EMAIL=""
ORG_NAME="Default Organization"
ORG_SLUG="default"
SKIP_CLICKHOUSE=0
APP_DIR=/opt/emonitor
ETC_DIR=/etc/emonitor
ENV_FILE=$ETC_DIR/emonitor.env
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --org-name) ORG_NAME="$2"; shift 2 ;;
    --org-slug) ORG_SLUG="$2"; shift 2 ;;
    --skip-clickhouse) SKIP_CLICKHOUSE=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ -n "$DOMAIN" && -n "$ADMIN_EMAIL" ]] || { echo "--domain and --admin-email are required"; exit 2; }

log() { echo -e "\033[1;34m==>\033[0m $*"; }
# Run a command as the service account with the platform environment loaded.
as_emonitor() { sudo -u emonitor bash -c 'set -a; source "$0"; set +a; cd /opt/emonitor/backend; exec "$@"' "$ENV_FILE" "$@"; }
rand() { python3 -c "import secrets; print(secrets.token_urlsafe(${1:-32}))"; }

log "Installing OS packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q python3 python3-venv python3-dev build-essential libpq-dev postgresql postgresql-contrib \
  redis-server nginx curl gnupg ca-certificates iputils-ping ufw rsync
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  log "Installing Node.js 22 (build-time only, for the frontend)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if [[ $SKIP_CLICKHOUSE -eq 0 ]] && ! command -v clickhouse-server >/dev/null; then
  log "Installing ClickHouse from the official repository"
  curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' | gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg] https://packages.clickhouse.com/deb stable main" \
    > /etc/apt/sources.list.d/clickhouse.list
  apt-get update -q
  apt-get install -y -q clickhouse-server clickhouse-client
fi

log "Creating service account and directories"
id emonitor >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin emonitor
install -d -o root -g emonitor -m 0750 "$ETC_DIR"
install -d -o emonitor -g emonitor -m 0750 /var/lib/emonitor
install -d -o root -g root -m 0711 /var/backups/emonitor   # traversable so clickhouse can write its BACKUP subdir
install -d -o root -g root -m 0755 "$APP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating configuration $ENV_FILE"
  PG_APP_PW=$(rand 24); PG_OWNER_PW=$(rand 24); REDIS_PW=$(rand 24); CH_PW=$(rand 24)
  FERNET=$(python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())")
  sed -e "s|^EMONITOR_PUBLIC_BASE_URL=.*|EMONITOR_PUBLIC_BASE_URL=https://$DOMAIN|" \
      -e "s|^EMONITOR_CORS_ORIGINS=.*|EMONITOR_CORS_ORIGINS=https://$DOMAIN|" \
      -e "s|^EMONITOR_SECRET_KEY=.*|EMONITOR_SECRET_KEY=$(rand 48)|" \
      -e "s|^EMONITOR_ENCRYPTION_KEY=.*|EMONITOR_ENCRYPTION_KEY=$FERNET|" \
      -e "s|^EMONITOR_DATABASE_URL=.*|EMONITOR_DATABASE_URL=postgresql+asyncpg://emonitor_app:$PG_APP_PW@127.0.0.1:5432/emonitor|" \
      -e "s|^EMONITOR_REDIS_URL=.*|EMONITOR_REDIS_URL=redis://:$REDIS_PW@127.0.0.1:6379/0|" \
      -e "s|^EMONITOR_CLICKHOUSE_PASSWORD=.*|EMONITOR_CLICKHOUSE_PASSWORD=$CH_PW|" \
      "$SRC_DIR/.env.example" > "$ENV_FILE"
  echo "EMONITOR_MIGRATION_DATABASE_URL=postgresql+asyncpg://emonitor_owner:$PG_OWNER_PW@127.0.0.1:5432/emonitor" >> "$ENV_FILE"
  chown root:emonitor "$ENV_FILE"; chmod 0640 "$ENV_FILE"
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
PG_APP_PW=$(sed -E 's|.*://emonitor_app:([^@]+)@.*|\1|' <<<"$EMONITOR_DATABASE_URL")
PG_OWNER_PW=$(sed -E 's|.*://emonitor_owner:([^@]+)@.*|\1|' <<<"$EMONITOR_MIGRATION_DATABASE_URL")
REDIS_PW=$(sed -E 's|redis://:([^@]+)@.*|\1|' <<<"$EMONITOR_REDIS_URL")

log "Configuring PostgreSQL (owner + least-privilege application role)"
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
GRANT USAGE ON SCHEMA public TO emonitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emonitor_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO emonitor_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emonitor_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO emonitor_app;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO emonitor_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emonitor_app;
SQL

log "Configuring Redis (localhost only, password, no dangerous commands)"
install -m 0640 -o redis -g redis "$SRC_DIR/deployment/redis/emonitor.conf" /etc/redis/emonitor.conf
sed -i "s|^requirepass .*|requirepass $REDIS_PW|" /etc/redis/emonitor.conf
grep -q "include /etc/redis/emonitor.conf" /etc/redis/redis.conf || echo "include /etc/redis/emonitor.conf" >> /etc/redis/redis.conf
systemctl restart redis-server

if [[ $SKIP_CLICKHOUSE -eq 0 ]]; then
  log "Configuring ClickHouse (localhost, dedicated user)"
  install -m 0640 -o clickhouse -g clickhouse "$SRC_DIR/deployment/clickhouse/emonitor-listen.xml" /etc/clickhouse-server/config.d/emonitor-listen.xml
  CH_HASH=$(printf '%s' "$EMONITOR_CLICKHOUSE_PASSWORD" | sha256sum | cut -d' ' -f1)
  sed "s|__PASSWORD_SHA256__|$CH_HASH|" "$SRC_DIR/deployment/clickhouse/emonitor-user.xml" > /etc/clickhouse-server/users.d/emonitor-user.xml
  chown clickhouse:clickhouse /etc/clickhouse-server/users.d/emonitor-user.xml; chmod 0640 /etc/clickhouse-server/users.d/emonitor-user.xml
  systemctl enable --now clickhouse-server
  systemctl restart clickhouse-server
  for _ in $(seq 1 30); do clickhouse-client --user emonitor --password "$EMONITOR_CLICKHOUSE_PASSWORD" -q "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
fi

log "Deploying application code to $APP_DIR"
rsync -a --delete --exclude '.venv' --exclude 'node_modules' --exclude '__pycache__' --exclude 'tests' \
  "$SRC_DIR/backend/" "$APP_DIR/backend/"
rsync -a --delete --exclude '__pycache__' "$SRC_DIR/agent/" "$APP_DIR/agent/"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip wheel
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

log "Building frontend"
( cd "$SRC_DIR/frontend" && npm ci --no-audit --no-fund && npm run build )
rsync -a --delete "$SRC_DIR/frontend/dist/" "$APP_DIR/frontend/dist/"

log "Running database migrations"
as_emonitor "$APP_DIR/venv/bin/alembic" upgrade head
if [[ $SKIP_CLICKHOUSE -eq 0 ]]; then
  as_emonitor "$APP_DIR/venv/bin/python" -m app.cli clickhouse-migrate
fi

log "Installing systemd units"
install -m 0644 "$SRC_DIR"/deployment/systemd/*.service "$SRC_DIR"/deployment/systemd/*.target /etc/systemd/system/
install -m 0644 "$SRC_DIR/deployment/journald/emonitor.conf" /etc/systemd/journald.conf.d/emonitor.conf 2>/dev/null || {
  install -d /etc/systemd/journald.conf.d; install -m 0644 "$SRC_DIR/deployment/journald/emonitor.conf" /etc/systemd/journald.conf.d/emonitor.conf; }
install -m 0644 "$SRC_DIR/deployment/logrotate/emonitor" /etc/logrotate.d/emonitor
systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable emonitor.target
systemctl restart emonitor.target

log "Configuring nginx"
install -m 0644 "$SRC_DIR/deployment/nginx/emonitor-proxy.conf" /etc/nginx/snippets/emonitor-proxy.conf
sed "s/monitor.example.com/$DOMAIN/g" "$SRC_DIR/deployment/nginx/emonitor.conf" > /etc/nginx/sites-available/emonitor
ln -sf /etc/nginx/sites-available/emonitor /etc/nginx/sites-enabled/emonitor
rm -f /etc/nginx/sites-enabled/default
install -d /var/www/letsencrypt
if [[ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]]; then
  log "No TLS certificate yet: serving HTTP only until you run certbot (see docs/DEPLOYMENT.md §HTTPS)"
  sed -i '/listen 443/,$d' /etc/nginx/sites-available/emonitor
  sed -i 's|location / { return 301 https://$host$request_uri; }|include /etc/nginx/snippets/emonitor-http-bootstrap.conf;|' /etc/nginx/sites-available/emonitor
  cat > /etc/nginx/snippets/emonitor-http-bootstrap.conf <<EOF
root $APP_DIR/frontend/dist;
location / { try_files \$uri /index.html; }
location /api/ { proxy_pass http://127.0.0.1:8000; include /etc/nginx/snippets/emonitor-proxy.conf; }
EOF
fi
nginx -t && systemctl reload nginx

log "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

log "Backups (daily 02:30)"
install -m 0750 "$SRC_DIR/deployment/backup/backup.sh" /usr/local/sbin/emonitor-backup
install -m 0750 "$SRC_DIR/deployment/backup/restore.sh" /usr/local/sbin/emonitor-restore
echo "30 2 * * * root /usr/local/sbin/emonitor-backup >> /var/log/emonitor-backup.log 2>&1" > /etc/cron.d/emonitor-backup

log "Creating the first Super Administrator ($ADMIN_EMAIL)"
as_emonitor "$APP_DIR/venv/bin/python" -m app.cli bootstrap --email "$ADMIN_EMAIL" \
  --org-name "$ORG_NAME" --org-slug "$ORG_SLUG" || true

log "Done. Next: obtain a certificate (certbot --nginx -d $DOMAIN), then open https://$DOMAIN"
curl -fsS http://127.0.0.1:8000/api/v1/health/ready || echo "(readiness check failed — see: journalctl -u emonitor-api)"
