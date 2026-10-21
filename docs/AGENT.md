# eMonitor Linux agent

A single Python package (`agent/monitor_agent`) using only the standard library (Python ≥ 3.10).

## What it collects (every `interval_seconds`, default 30 s; the server may adjust within 10–3600 s)
CPU % and iowait, load 1/5/15, running procs, memory/swap %, used/available bytes, per-filesystem usage,
free/total bytes and inode %, per-disk read/write IOPS and bytes/s, per-interface rx/tx bytes/s and errors/s,
interface up/down, process count, TCP connection count, uptime, and `service_up{unit}` for systemd units
listed in the local config. Optional log tailing of locally allowlisted files (plain text or JSON lines),
rotation- and truncation-safe.

## Install
The portal has a step-by-step guide at **Monitor → Install Agent** (`/agents/install`): create a token, copy the
ready-made command, verify, configure, upgrade, uninstall, troubleshoot.

1. Create an enrollment token (Install Agent page, *Integrations → Agent enrollment*, or *Server → Agent tab*).
2. On the server, as a user with sudo:
   ```bash
   curl -fsSL https://<portal>/api/v1/agents/install.sh | sudo bash -s -- --token emt_... [--services "ssh nginx"] [--ca /path/ca.pem]
   ```
   The bootstrap script (served by the portal, `GET /api/v1/agents/install.sh`) downloads the agent package
   (`GET /api/v1/agents/package.tar.gz`), verifies its SHA-256, and runs `scripts/install.sh`, which creates the
   `emonitor-agent` user, installs to `/opt/emonitor-agent`, writes `/etc/emonitor-agent/agent.json`, enrolls
   (credentials in `/etc/emonitor-agent/credentials.json`, mode 0600) and starts `emonitor-agent.service`.
   Re-running it on an enrolled host does not enroll again (use `--reenroll` with a new token to replace credentials).
3. Optional: edit `/etc/emonitor-agent/agent.json` (see `agent/agent.example.json`) for services and log files,
   then `systemctl restart emonitor-agent`.

Offline: download the package from the guide page, copy it to the server, `tar -xzf` it and run
`sudo bash agent/scripts/install.sh --server https://<portal> --token emt_...`.

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
```bash
curl -fsSL https://<portal>/api/v1/agents/install.sh | sudo bash -s -- --upgrade
```
Keeps configuration and credentials. *Integrations → Agents* lists the version reported by each host.

## Uninstall
`sudo emonitor-agent-uninstall [--purge]` (installed by the installer) and revoke the agent in the UI.

## Platform support
Linux only in this release. Collectors implement the `Collector` protocol (`collectors.py`), so a Windows
collector (WMI/PDH) can be added without changing transport, spool or server APIs.
