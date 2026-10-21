#!/usr/bin/env bash
# Install the eMonitor agent on a Linux host (systemd). Requires python3 >= 3.10; no pip packages.
#
#   sudo ./install.sh --server https://monitor.example.com --token emt_xxx [--services "nginx ssh"] [--ca /path/ca.pem]
#
# The enrollment token is single-use and created in the UI (Integrations → Agents or Server → Agent tab).
set -euo pipefail
SERVER=""; TOKEN="${EMONITOR_ENROLLMENT_TOKEN:-}"; SERVICES=""; CA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --ca) CA="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ -n "$SERVER" && -n "$TOKEN" ]] || { echo "--server and --token are required"; exit 2; }
[[ "$SERVER" == https://* ]] || { echo "server URL must use https://"; exit 2; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { echo "python3 >= 3.10 required"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

id emonitor-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin emonitor-agent
install -d -o root -g root -m 0755 /opt/emonitor-agent
rm -rf /opt/emonitor-agent/monitor_agent
cp -r "$HERE/monitor_agent" /opt/emonitor-agent/
find /opt/emonitor-agent -name '__pycache__' -prune -exec rm -rf {} +
chmod -R a+rX,go-w /opt/emonitor-agent
install -d -o emonitor-agent -g emonitor-agent -m 0700 /etc/emonitor-agent /var/lib/emonitor-agent

if [[ ! -f /etc/emonitor-agent/agent.json ]]; then
  python3 - "$SERVER" "$SERVICES" "$CA" <<'PY'
import json, sys
server, services, ca = sys.argv[1], sys.argv[2].split(), sys.argv[3] or None
cfg = {"server_url": server, "credentials_file": "/etc/emonitor-agent/credentials.json",
       "state_dir": "/var/lib/emonitor-agent", "ca_bundle": ca, "interval_seconds": 30, "services": services,
       "log_files": [], "spool_max_mb": 50, "rotate_credentials_days": 30}
open("/etc/emonitor-agent/agent.json", "w").write(json.dumps(cfg, indent=2))
PY
  chown emonitor-agent:emonitor-agent /etc/emonitor-agent/agent.json
  chmod 0600 /etc/emonitor-agent/agent.json
fi

echo "==> Enrolling with $SERVER"
sudo -u emonitor-agent env PYTHONPATH=/opt/emonitor-agent EMONITOR_ENROLLMENT_TOKEN="$TOKEN" \
  python3 -m monitor_agent --config /etc/emonitor-agent/agent.json enroll --server "$SERVER"

install -m 0644 "$HERE/systemd/emonitor-agent.service" /etc/systemd/system/emonitor-agent.service
cat > /usr/local/bin/emonitor-agent <<'SH'
#!/bin/sh
exec sudo -u emonitor-agent env PYTHONPATH=/opt/emonitor-agent python3 -m monitor_agent --config /etc/emonitor-agent/agent.json "$@"
SH
chmod 0755 /usr/local/bin/emonitor-agent
systemctl daemon-reload
systemctl enable --now emonitor-agent
sleep 2
systemctl --no-pager --lines=5 status emonitor-agent || true
echo "Installed. Edit /etc/emonitor-agent/agent.json for services/log files, then: systemctl restart emonitor-agent"
