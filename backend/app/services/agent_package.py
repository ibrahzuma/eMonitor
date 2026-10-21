"""Serve the Linux agent from the platform itself: package tarball + one-line bootstrap installer.

The agent source lives next to the backend (`<install root>/agent`, e.g. /opt/emonitor/agent). The
tarball is built once per process and cached; its SHA-256 is embedded in the bootstrap script so the
download is verified before anything is executed on the target host.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import tarfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.core.config import get_settings

_INCLUDE = ("monitor_agent", "scripts", "systemd", "agent.example.json")
_SKIP_DIRS = {"__pycache__", "tests", ".pytest_cache"}


def agent_dir() -> Path:
    override = os.environ.get("EMONITOR_AGENT_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "agent"  # backend/app/services → <root>/agent


@dataclass(frozen=True)
class Package:
    data: bytes
    sha256: str
    version: str


@lru_cache(maxsize=1)
def build_package() -> Package:
    root = agent_dir()
    if not (root / "monitor_agent" / "__init__.py").is_file():
        raise FileNotFoundError(f"agent sources not found in {root}")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', (root / "monitor_agent" / "__init__.py").read_text(encoding="utf-8"))
    version = m.group(1) if m else "unknown"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        for name in _INCLUDE:
            path = root / name
            if not path.exists():
                continue
            for p in sorted([path] if path.is_file() else path.rglob("*")):
                if any(part in _SKIP_DIRS for part in p.relative_to(root).parts) or p.suffix in (".pyc", ".pyo"):
                    continue
                info = tar.gettarinfo(str(p), arcname=f"agent/{p.relative_to(root).as_posix()}")
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mtime = 0  # reproducible archive → stable checksum
                if info.isfile():
                    info.mode = 0o755 if p.suffix == ".sh" else 0o644
                    with open(p, "rb") as fh:
                        tar.addfile(info, fh)
                elif info.isdir():
                    info.mode = 0o755
                    tar.addfile(info)
    data = buf.getvalue()
    return Package(data=data, sha256=hashlib.sha256(data).hexdigest(), version=version)


def server_url() -> str:
    return get_settings().public_base_url.rstrip("/")


def install_command(token: str) -> str:
    return f"curl -fsSL {server_url()}/api/v1/agents/install.sh | sudo bash -s -- --token {token}"


def bootstrap_script() -> str:
    pkg = build_package()
    base = server_url()
    return f"""#!/usr/bin/env bash
# eMonitor agent bootstrap installer (served by {base})
#
#   Install:  curl -fsSL {base}/api/v1/agents/install.sh | sudo bash -s -- --token <ENROLLMENT_TOKEN> [--services "ssh nginx"]
#   Upgrade:  curl -fsSL {base}/api/v1/agents/install.sh | sudo bash -s -- --upgrade
#
# Downloads agent version {pkg.version}, verifies its SHA-256 checksum, then runs scripts/install.sh.
set -euo pipefail
SERVER="{base}"
EXPECTED_SHA256="{pkg.sha256}"
if [[ $EUID -ne 0 ]]; then
  echo "Please run as root, e.g.: curl -fsSL $SERVER/api/v1/agents/install.sh | sudo bash -s -- --token <TOKEN>" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then echo "The eMonitor agent currently supports Linux only." >&2; exit 1; fi
command -v systemctl >/dev/null || {{ echo "systemd is required." >&2; exit 1; }}
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "python3 >= 3.10 is required. Install it first (Debian/Ubuntu: apt-get install -y python3, RHEL/Rocky: dnf install -y python3)." >&2
  exit 1
fi
command -v sudo >/dev/null || {{ echo "sudo is required (apt-get install -y sudo / dnf install -y sudo)." >&2; exit 1; }}
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "==> Downloading eMonitor agent {pkg.version} from $SERVER"
curl -fsSL "$SERVER/api/v1/agents/package.tar.gz" -o "$TMP/agent.tar.gz"
echo "$EXPECTED_SHA256  $TMP/agent.tar.gz" | sha256sum -c --quiet - || {{ echo "Checksum mismatch — aborting." >&2; exit 1; }}
tar -xzf "$TMP/agent.tar.gz" -C "$TMP"
bash "$TMP/agent/scripts/install.sh" --server "$SERVER" "$@"
"""
