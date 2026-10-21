#!/usr/bin/env bash
# eMonitor backup: PostgreSQL (full logical dump), ClickHouse (native BACKUP), configuration.
# Usage: emonitor-backup [destination_dir]      (default /var/backups/emonitor, keeps 14 days)
# ClickHouse admin access: set CLICKHOUSE_ADMIN_USER / CLICKHOUSE_ADMIN_PASSWORD (default: user "default").
set -euo pipefail
DEST="${1:-/var/backups/emonitor}"
KEEP_DAYS="${EMONITOR_BACKUP_KEEP_DAYS:-14}"
ENV_FILE=/etc/emonitor/emonitor.env
set -a; source "$ENV_FILE"; set +a
TS=$(date -u +%Y%m%dT%H%M%SZ)
DIR="$DEST/$TS"
install -d -m 0700 "$DIR"
# ClickHouse writes its native backup as the clickhouse user
id clickhouse >/dev/null 2>&1 && { chgrp clickhouse "$DIR"; chmod 0770 "$DIR"; }
CH=(clickhouse-client --user "${CLICKHOUSE_ADMIN_USER:-default}")
[[ -n "${CLICKHOUSE_ADMIN_PASSWORD:-}" ]] && CH+=(--password "$CLICKHOUSE_ADMIN_PASSWORD")

echo "[$TS] PostgreSQL dump"
sudo -u postgres pg_dump --format=custom --compress=6 --no-owner emonitor > "$DIR/postgres.dump"

if command -v clickhouse-client >/dev/null; then
  echo "[$TS] ClickHouse backup"
  # Native BACKUP requires <backups><allowed_path>/var/backups/emonitor/</allowed_path> (installed by install.sh).
  if "${CH[@]}" -q "BACKUP DATABASE ${EMONITOR_CLICKHOUSE_DATABASE} TO File('$DIR/clickhouse')" >/dev/null; then
    echo "ClickHouse native backup written"
  else
    echo "Native ClickHouse backup failed; exporting tables in Native format instead"
    install -d -m 0700 "$DIR/clickhouse-export"
    for t in check_results events metrics logs; do
      "${CH[@]}" -q "SELECT * FROM ${EMONITOR_CLICKHOUSE_DATABASE}.$t FORMAT Native" | gzip > "$DIR/clickhouse-export/$t.native.gz"
    done
  fi
fi

echo "[$TS] Configuration (contains EMONITOR_ENCRYPTION_KEY — protect and store this backup securely)"
cp -a /etc/emonitor "$DIR/etc-emonitor"
cp -a /etc/nginx/sites-available/emonitor "$DIR/nginx-emonitor.conf" 2>/dev/null || true
( cd "$DIR" && sha256sum postgres.dump > SHA256SUMS )
chmod -R go-rwx "$DIR"

find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "[$TS] Backup complete: $DIR"
