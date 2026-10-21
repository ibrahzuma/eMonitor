"""Agent distribution: public bootstrap script + package, checksum, install command."""

from __future__ import annotations

import hashlib
import io
import tarfile

from tests.conftest import make_actor

API = "/api/v1"


async def test_package_and_bootstrap_script_are_consistent(client):
    pkg = await client.get(f"{API}/agents/package.tar.gz")
    assert pkg.status_code == 200 and pkg.headers["content-type"] == "application/gzip"
    sha = hashlib.sha256(pkg.content).hexdigest()
    assert pkg.headers["X-Checksum-SHA256"] == sha
    names = tarfile.open(fileobj=io.BytesIO(pkg.content)).getnames()
    assert "agent/monitor_agent/agent.py" in names and "agent/scripts/install.sh" in names
    assert not any("__pycache__" in n or "/tests" in n for n in names)
    script = await client.get(f"{API}/agents/install.sh")  # no authentication needed
    assert script.status_code == 200
    assert f'EXPECTED_SHA256="{sha}"' in script.text and "sha256sum -c" in script.text
    assert script.text.startswith("#!/usr/bin/env bash")


async def test_install_command_and_info(client):
    a = await make_actor(client)
    tok = (await client.post(f"{API}/agents/enrollment-tokens", headers=a.headers, json={})).json()
    assert tok["install_command"].startswith("curl -fsSL ") and "/api/v1/agents/install.sh | sudo bash -s -- --token emt_" in tok["install_command"]
    info = (await client.get(f"{API}/agents/info", headers=a.headers)).json()
    assert info["install_script_url"].endswith("/api/v1/agents/install.sh") and info["agent_version"]
    assert "--upgrade" in info["upgrade_command"]
    assert (await client.get(f"{API}/agents/info")).status_code == 401
