#!/usr/bin/env bash
# eMonitor restore. Usage: emonitor-restore /var/backups/emonitor/<TIMESTAMP> [--with-config]
# Stops services, restores PostgreSQL and ClickHouse, restarts. The previous PostgreSQL database
# is kept as "emonitor_restore_old" until you drop it.
set -euo pipefail
DIR="${1:?backup directory required}"
WITH_CONFIG="${2:-}"
[[ -f "$DIR/postgres.dump" ]] || { echo "no postgres.dump in $DIR"; exit 1; }
( cd "$DIR" && sha256sum -c SHA256SUMS )
read -r -p "This REPLACES current eMonitor data with $DIR. Type RESTORE to continue: " ok
[[ "$ok" == "RESTORE" ]] || exit 1

if [[ "$WITH_CONFIG" == "--with-config" ]]; then
  cp -a "$DIR/etc-emonitor/." /etc/emonitor/
fi
set -a; source /etc/emonitor/emonitor.env; set +a
CH=(clickhouse-client --user "${CLICKHOUSE_ADMIN_USER:-default}")
[[ -n "${CLICKHOUSE_ADMIN_PASSWORD:-}" ]] && CH+=(--password "$CLICKHOUSE_ADMIN_PASSWORD")

systemctl stop emonitor.target emonitor-syslog.service 2>/dev/null || true
echo "Restoring PostgreSQL"
sudo -u postgres dropdb --if-exists emonitor_restore_old
sudo -u postgres psql -qc "ALTER DATABASE emonitor RENAME TO emonitor_restore_old" || true
sudo -u postgres createdb -O emonitor_owner emonitor
sudo -u postgres pg_restore --no-owner --role=emonitor_owner -d emonitor "$DIR/postgres.dump"
sudo -u postgres psql -q -d emonitor -c "GRANT USAGE ON SCHEMA public TO emonitor_app" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO emonitor_app" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emonitor_app"

if [[ -d "$DIR/clickhouse" ]]; then
  echo "Restoring ClickHouse (native)"
  "${CH[@]}" -q "DROP DATABASE IF EXISTS ${EMONITOR_CLICKHOUSE_DATABASE}"
  "${CH[@]}" -q "RESTORE DATABASE ${EMONITOR_CLICKHOUSE_DATABASE} FROM File('$DIR/clickhouse')"
elif [[ -d "$DIR/clickhouse-export" ]]; then
  echo "Restoring ClickHouse (Native export)"
  for f in "$DIR"/clickhouse-export/*.native.gz; do
    t=$(basename "$f" .native.gz)
    "${CH[@]}" -q "TRUNCATE TABLE IF EXISTS ${EMONITOR_CLICKHOUSE_DATABASE}.$t"
    gunzip -c "$f" | "${CH[@]}" -q "INSERT INTO ${EMONITOR_CLICKHOUSE_DATABASE}.$t FORMAT Native"
  done
fi
systemctl start emonitor.target
echo "Restore complete. Verify, then: sudo -u postgres dropdb emonitor_restore_old"
