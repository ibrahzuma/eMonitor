#!/usr/bin/env bash
# Install or upgrade the eMonitor agent on a Linux host (systemd). Requires python3 >= 3.10; no pip packages.
#
#   Install:  sudo ./install.sh --server https://monitor.example.com --token emt_xxx [--services "nginx ssh"] [--ca /path/ca.pem]
#   Upgrade:  sudo ./install.sh --server https://monitor.example.com --upgrade
#   Re-enroll (new token, replaces credentials): add --reenroll
#
# The enrollment token is created in the portal (Install Agent page, Integrations → Agent enrollment,
# or Server → Agent tab). A host that is already enrolled is never enrolled twice unless --reenroll is given.
set -euo pipefail
SERVER=""; TOKEN="${EMONITOR_ENROLLMENT_TOKEN:-}"; SERVICES=""; CA=""; UPGRADE=0; REENROLL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --services) SERVICES="$2"; shift 2 ;;
    --ca) CA="$2"; shift 2 ;;
    --upgrade) UPGRADE=1; shift ;;
    --reenroll) REENROLL=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ -n "$SERVER" ]] || { echo "--server is required"; exit 2; }
[[ "$SERVER" == https://* ]] || { echo "server URL must use https://"; exit 2; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { echo "python3 >= 3.10 required"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREDS=/etc/emonitor-agent/credentials.json
ENROLLED=0; [[ -s "$CREDS" ]] && ENROLLED=1
if [[ $UPGRADE -eq 1 && $ENROLLED -eq 0 ]]; then
  echo "This host is not enrolled yet — run the install command with --token instead of --upgrade."; exit 2
fi
if [[ $UPGRADE -eq 0 && ( $ENROLLED -eq 0 || $REENROLL -eq 1 ) && -z "$TOKEN" ]]; then
  echo "--token is required to enroll this host"; exit 2
fi

echo "==> Installing agent files to /opt/emonitor-agent"
id emonitor-agent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin emonitor-agent
install -d -o root -g root -m 0755 /opt/emonitor-agent
rm -rf /opt/emonitor-agent/monitor_agent
cp -r "$HERE/monitor_agent" /opt/emonitor-agent/
find /opt/emonitor-agent -name '__pycache__' -prune -exec rm -rf {} +
chmod -R a+rX,go-w /opt/emonitor-agent
install -d -o emonitor-agent -g emonitor-agent -m 0700 /etc/emonitor-agent /var/lib/emonitor-agent
install -m 0750 "$HERE/scripts/uninstall.sh" /usr/local/sbin/emonitor-agent-uninstall

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
elif [[ -n "$SERVICES" ]]; then
  python3 - "$SERVICES" <<'PY'
import json, sys
p = "/etc/emonitor-agent/agent.json"
cfg = json.load(open(p)); cfg["services"] = sys.argv[1].split()
open(p, "w").write(json.dumps(cfg, indent=2))
PY
fi

if [[ $UPGRADE -eq 0 && ( $ENROLLED -eq 0 || $REENROLL -eq 1 ) ]]; then
  echo "==> Enrolling with $SERVER"
  sudo -u emonitor-agent env PYTHONPATH=/opt/emonitor-agent EMONITOR_ENROLLMENT_TOKEN="$TOKEN" \
    python3 -m monitor_agent --config /etc/emonitor-agent/agent.json enroll --server "$SERVER"
else
  echo "==> Host already enrolled — keeping existing credentials (use --reenroll with a new token to replace them)"
fi

install -m 0644 "$HERE/systemd/emonitor-agent.service" /etc/systemd/system/emonitor-agent.service
cat > /usr/local/bin/emonitor-agent <<'SH'
#!/bin/sh
exec sudo -u emonitor-agent env PYTHONPATH=/opt/emonitor-agent python3 -m monitor_agent --config /etc/emonitor-agent/agent.json "$@"
SH
chmod 0755 /usr/local/bin/emonitor-agent
systemctl daemon-reload
systemctl enable emonitor-agent >/dev/null 2>&1
systemctl restart emonitor-agent
sleep 2
if systemctl is-active --quiet emonitor-agent; then
  echo "==> emonitor-agent $(emonitor-agent version 2>/dev/null) is running. The server appears in the portal within ~1 minute."
else
  echo "!! emonitor-agent failed to start — see: journalctl -u emonitor-agent -n 50"; exit 1
fi
echo "Configure monitored services / log files in /etc/emonitor-agent/agent.json, then: systemctl restart emonitor-agent"
echo "Uninstall: sudo emonitor-agent-uninstall [--purge]"
