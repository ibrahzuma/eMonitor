#!/usr/bin/env bash
# Upgrade eMonitor in place from a new source checkout:  sudo ./deployment/scripts/upgrade.sh
# Takes a backup and a code snapshot first. Rollback procedure: docs/DEPLOYMENT.md §9.
set -euo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/emonitor
ENV_FILE=/etc/emonitor/emonitor.env
as_emonitor() { sudo -u emonitor bash -c 'set -a; source "$0"; set +a; cd /opt/emonitor/backend; exec "$@"' "$ENV_FILE" "$@"; }
TS=$(date -u +%Y%m%dT%H%M%SZ)

echo "==> Pre-upgrade backup"
/usr/local/sbin/emonitor-backup
echo "==> Snapshot current release to $APP_DIR/releases/$TS.tar.gz"
install -d "$APP_DIR/releases"
tar -C "$APP_DIR" -czf "$APP_DIR/releases/$TS.tar.gz" backend frontend agent
echo "==> Build frontend"
( cd "$SRC_DIR/frontend" && npm ci --no-audit --no-fund && npm run build )
echo "==> Stop background services (API keeps serving)"
systemctl stop emonitor-scheduler emonitor-beat 'emonitor-worker@*' emonitor-ingest
rsync -a --delete --exclude '__pycache__' --exclude 'tests' --exclude '.venv' "$SRC_DIR/backend/" "$APP_DIR/backend/"
rsync -a --delete --exclude '__pycache__' "$SRC_DIR/agent/" "$APP_DIR/agent/"
rsync -a --delete "$SRC_DIR/frontend/dist/" "$APP_DIR/frontend/dist/"
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"
echo "==> Migrate databases"
as_emonitor "$APP_DIR/venv/bin/alembic" upgrade head
as_emonitor "$APP_DIR/venv/bin/python" -m app.cli clickhouse-migrate
install -m 0644 "$SRC_DIR"/deployment/systemd/*.service "$SRC_DIR"/deployment/systemd/*.target /etc/systemd/system/
systemctl daemon-reload
systemctl restart emonitor.target
sleep 3
curl -fsS http://127.0.0.1:8000/api/v1/health/ready && echo && echo "Upgrade complete ($TS)"
