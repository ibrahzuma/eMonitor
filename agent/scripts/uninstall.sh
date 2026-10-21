#!/usr/bin/env bash
# Remove the eMonitor agent. Revoke the agent in the UI as well (Integrations → Agents → Revoke).
#   sudo ./uninstall.sh [--purge]     --purge also deletes credentials, config and spooled data
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
systemctl disable --now emonitor-agent 2>/dev/null || true
rm -f /etc/systemd/system/emonitor-agent.service /usr/local/bin/emonitor-agent /usr/local/sbin/emonitor-agent-uninstall
systemctl daemon-reload
rm -rf /opt/emonitor-agent
if [[ "${1:-}" == "--purge" ]]; then
  rm -rf /etc/emonitor-agent /var/lib/emonitor-agent
  userdel emonitor-agent 2>/dev/null || true
  echo "Agent removed (purged)."
else
  echo "Agent removed. Config/credentials kept in /etc/emonitor-agent (use --purge to delete)."
fi
