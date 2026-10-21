"""SSRF and unauthorized-target protections."""

from __future__ import annotations

import ipaddress

import pytest

from app.monitoring import netguard
from app.monitoring.netguard import Scope, TargetNotAllowed, check_ip
from tests.conftest import make_actor

API = "/api/v1"


def ip(v: str):
    return ipaddress.ip_address(v)


@pytest.mark.parametrize("addr", ["169.254.169.254", "100.100.100.200", "192.0.0.192", "0.0.0.0", "224.0.0.1",
                                  "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254", "255.255.255.255"])
def test_metadata_and_reserved_always_blocked(addr):
    # even if an admin authorizes the whole private space
    scope = Scope(allow_public=True, cidrs=(ipaddress.ip_network("0.0.0.0/1"), ipaddress.ip_network("128.0.0.0/1"),
                                            ipaddress.ip_network("::/1"), ipaddress.ip_network("8000::/1")))
    with pytest.raises(TargetNotAllowed):
        check_ip(ip(addr), scope)


@pytest.mark.parametrize("addr", ["127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.1.1", "100.64.0.1", "::1", "fc00::1"])
def test_private_addresses_require_authorized_cidr(addr):
    with pytest.raises(TargetNotAllowed):
        check_ip(ip(addr), Scope(allow_public=True))
    net = ipaddress.ip_network(addr + ("/128" if ":" in addr else "/32"))
    check_ip(ip(addr), Scope(allow_public=True, cidrs=(net,)))


def test_private_disallowed_platform_wide():
    with pytest.raises(TargetNotAllowed):
        check_ip(ip("10.0.0.5"), Scope(cidrs=(ipaddress.ip_network("10.0.0.0/8"),), allow_private=False))


def test_platform_blocked_cidrs_override_scope():
    scope = Scope(cidrs=(ipaddress.ip_network("10.0.0.0/8"),), blocked=(ipaddress.ip_network("10.9.0.0/16"),))
    check_ip(ip("10.1.0.1"), scope)
    with pytest.raises(TargetNotAllowed):
        check_ip(ip("10.9.0.1"), scope)


def test_public_targets_follow_allow_public_and_hostname_scope():
    restricted = Scope(allow_public=False, hostnames=(".example.com",))
    with pytest.raises(TargetNotAllowed):
        check_ip(ip("93.184.216.34"), restricted)
    check_ip(ip("93.184.216.34"), restricted, hostname="www.example.com")
    check_ip(ip("93.184.216.34"), Scope(allow_public=True))
    assert netguard.hostname_in_scope("api.example.com", Scope(hostnames=("example.com",)))
    assert not netguard.hostname_in_scope("evilexample.com", Scope(hostnames=("example.com",)))


@pytest.mark.parametrize("host", ["localhost", "foo.localhost", "metadata.google.internal"])
def test_static_hostname_policy(host):
    with pytest.raises(TargetNotAllowed):
        netguard.static_validate(host, Scope())


async def test_authorize_rejects_mixed_resolution(monkeypatch):
    async def fake_resolve(host, port=None):
        return [ip("93.184.216.34"), ip("10.0.0.1")]

    monkeypatch.setattr(netguard, "resolve", fake_resolve)
    with pytest.raises(TargetNotAllowed):
        await netguard.authorize("rebind.example.org", Scope(allow_public=True))


async def test_authorize_dns_failure_is_resolution_error(monkeypatch):
    import socket

    async def fail(host, port=None):
        raise socket.gaierror("nope")

    monkeypatch.setattr(netguard, "resolve", fail)
    with pytest.raises(netguard.ResolutionError):
        await netguard.authorize("does-not-exist.invalid", Scope())


async def test_api_rejects_forbidden_targets(client):
    a = await make_actor(client, scope={"allow_public": True, "cidrs": [], "hostnames": []})
    for url in ("http://169.254.169.254/latest/meta-data/", "http://localhost:8080/", "http://10.0.0.5/",
                "http://[::1]/", "http://metadata.google.internal/"):
        r = await client.post(f"{API}/websites", headers=a.headers, json={"name": url, "url": url})
        assert r.status_code == 422, url
    r = await client.post(f"{API}/websites", headers=a.headers,
                          json={"name": "creds", "url": "https://user:pass@example.com/"})
    assert r.status_code == 422
    r = await client.post(f"{API}/websites", headers=a.headers, json={"name": "ftp", "url": "ftp://example.com/"})
    assert r.status_code == 422
    # webhook channels are guarded too
    r = await client.post(f"{API}/notifications/channels", headers=a.headers,
                          json={"name": "w", "type": "webhook", "config": {"url": "http://169.254.169.254/x"}})
    assert r.status_code == 422


async def test_scope_update_enables_private_target(client):
    a = await make_actor(client, scope={"allow_public": True, "cidrs": [], "hostnames": []})
    body = {"name": "intranet", "url": "http://10.20.0.5/health"}
    assert (await client.post(f"{API}/websites", headers=a.headers, json=body)).status_code == 422
    r = await client.patch(f"{API}/organizations/current", headers=a.headers,
                           json={"monitoring_scope": {"allow_public": True, "cidrs": ["10.20.0.0/16"], "hostnames": []}})
    assert r.status_code == 200
    assert (await client.post(f"{API}/websites", headers=a.headers, json=body)).status_code == 201
    bad = await client.patch(f"{API}/organizations/current", headers=a.headers,
                             json={"monitoring_scope": {"cidrs": ["0.0.0.0/0"]}})
    assert bad.status_code == 422
