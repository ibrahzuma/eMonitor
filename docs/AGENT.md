# eMonitor Linux agent

A single Python package (`agent/monitor_agent`) using only the standard library (Python ≥ 3.10).

## What it collects (every `interval_seconds`, default 30 s; the server may adjust within 10–3600 s)
CPU % and iowait, load 1/5/15, running procs, memory/swap %, used/available bytes, per-filesystem usage,
free/total bytes and inode %, per-disk read/write IOPS and bytes/s, per-interface rx/tx bytes/s and errors/s,
interface up/down, process count, TCP connection count, uptime, and `service_up{unit}` for systemd units
listed in the local config. Optional log tailing of locally allowlisted files (plain text or JSON lines),
rotation- and truncation-safe.

## Install
1. In the UI: *Server → Agent tab → Create enrollment token* (single-use, expires) or *Integrations → Agents*
   (multi-use token for fleets).
2. Copy the `agent/` directory to the host and run:
   ```bash
   sudo ./scripts/install.sh --server https://monitor.example.com --token emt_... --services "ssh nginx"
   ```
   Use `--ca /path/ca.pem` for a private CA. The script creates the `emonitor-agent` user, installs to
   `/opt/emonitor-agent`, writes `/etc/emonitor-agent/agent.json`, enrolls (credentials in
   `/etc/emonitor-agent/credentials.json`, mode 0600) and enables `emonitor-agent.service`.
3. Edit `/etc/emonitor-agent/agent.json` (see `agent/agent.example.json`) for services and log files, then
   `systemctl restart emonitor-agent`.

Commands: `emonitor-agent status`, `emonitor-agent collect-once` (prints a sample, no network),
`emonitor-agent version`.

## Reliability
* Failed deliveries are written to a bounded on-disk spool (`/var/lib/emonitor-agent/spool`, default 50 MB /
  2000 batches; oldest dropped first) and flushed when the server is reachable again.
* Exponential backoff with full jitter (cap 5 min); `Retry-After` honoured (the API returns 503 under ingest
  backpressure); 401/403 back off ≥ 5 min; 422 payloads are dropped (never retried forever).
* Credentials rotate automatically every 30 days (`rotate_credentials_days`); the previous secret stays valid
  10 minutes so in-flight requests succeed.

## Security
* Talks only HTTPS to the configured server with certificate verification.
* Never executes commands from the server. The only subprocess is `systemctl is-active -- <unit>` for unit
  names from the local config (validated against `^[A-Za-z0-9@._-]+$`).
* Hardened unit: unprivileged user, no capabilities, read-only filesystem except its state/config dirs,
  `CPUQuota=10%`, `MemoryMax=128M`.
* Revoke a compromised agent in the UI (*Integrations → Agents → Revoke*); re-enroll with a new token.

## Upgrade
Config and credentials are kept; only the code is replaced:
```bash
sudo rsync -a --delete agent/monitor_agent/ /opt/emonitor-agent/monitor_agent/
sudo cp agent/systemd/emonitor-agent.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl restart emonitor-agent && emonitor-agent version
```
(Re-running `install.sh` would enroll again and needs a new token.) The agent reports its version;
*Integrations → Agents* lists versions per host.

## Uninstall
`sudo ./scripts/uninstall.sh [--purge]` and revoke the agent in the UI.

## Platform support
Linux only in this release. Collectors implement the `Collector` protocol (`collectors.py`), so a Windows
collector (WMI/PDH) can be added without changing transport, spool or server APIs.
