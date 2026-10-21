"""Resource inventory API: servers, websites, devices, services, checks, groups, dependencies, import."""

from __future__ import annotations

from app.core.db import get_sessionmaker
from app.core.security import decrypt_json
from app.models import Check
from tests.conftest import make_actor

API = "/api/v1"


async def test_server_registration_and_update(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/servers", headers=a.headers, json={
        "name": "db-01", "hostname": "db-01.example.com", "ip_address": "93.184.216.34", "environment": "staging",
        "location": "FRA1", "business_owner": "Payments", "tags": ["db", "postgres"], "custom_fields": {"rack": "A3"},
        "monitoring_interval_seconds": 30, "monitored_services": ["postgresql"], "ping_check": True})
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["kind"] == "server" and s["server"]["hostname"] == "db-01.example.com" and s["status"] == "unknown"
    assert s["checks"][0]["type"] == "icmp"
    dup = await client.post(f"{API}/servers", headers=a.headers, json={"name": "db-01"})
    assert dup.status_code == 422 and dup.json()["error"]["code"] == "conflict"
    u = await client.patch(f"{API}/servers/{s['id']}", headers=a.headers,
                           json={"location": "FRA2", "thresholds": {"disk_percent": {"warning": 70, "critical": 85}}})
    assert u.json()["location"] == "FRA2" and u.json()["server"]["thresholds"]["disk_percent"]["warning"] == 70
    lst = (await client.get(f"{API}/servers", headers=a.headers, params={"tag": "db", "environment": "staging"})).json()
    assert lst["total"] == 1
    assert (await client.get(f"{API}/servers", headers=a.headers, params={"q": "nomatch"})).json()["total"] == 0
    bad_tag = await client.post(f"{API}/servers", headers=a.headers, json={"name": "x", "tags": ["bad tag!"]})
    assert bad_tag.status_code == 422


async def test_website_secrets_write_only_and_check_update(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/websites", headers=a.headers, json={
        "name": "Portal", "url": "https://portal.example.com/health", "expected_status": ["200", "2xx"],
        "keyword": "ok", "secrets": {"bearer_token": "tok-SECRET-123"}, "interval_seconds": 30, "timeout_seconds": 5})
    assert r.status_code == 201, r.text
    assert "tok-SECRET-123" not in r.text
    check = r.json()["checks"][0]
    assert check["has_secrets"] is True and check["config"]["expected_status"] == ["200", "2xx"]
    upd = await client.patch(f"{API}/checks/{check['id']}", headers=a.headers,
                             json={"config": {**check["config"], "keyword": "healthy"}, "interval_seconds": 120})
    assert upd.status_code == 200 and upd.json()["config"]["keyword"] == "healthy"
    async with get_sessionmaker()() as s:
        c = await s.get(Check, check["id"])
        assert decrypt_json(c.secret_config_enc) == {"bearer_token": "tok-SECRET-123", "headers": {}}
    bad = await client.patch(f"{API}/checks/{check['id']}", headers=a.headers, json={"timeout_seconds": 200})
    assert bad.status_code == 422
    bad = await client.patch(f"{API}/checks/{check['id']}", headers=a.headers, json={"interval_seconds": 5})
    assert bad.status_code == 422
    assert (await client.post(f"{API}/checks/{check['id']}/run", headers=a.headers)).status_code == 202
    bad_status = await client.post(f"{API}/websites", headers=a.headers,
                                   json={"name": "b", "url": "https://x.example.com", "expected_status": ["999"]})
    assert bad_status.status_code == 422
    hdr = await client.post(f"{API}/websites", headers=a.headers,
                            json={"name": "h", "url": "https://x.example.com", "headers": {"Host": "evil"}})
    assert hdr.status_code == 422


async def test_network_device_and_service_creation(client):
    a = await make_actor(client, scope={"allow_public": True, "cidrs": ["10.0.0.0/8"], "hostnames": []})
    r = await client.post(f"{API}/network-devices", headers=a.headers, json={
        "name": "core-sw-1", "host": "10.0.0.2", "vendor": "Cisco", "device_type": "switch",
        "snmp": {"port": 161, "version": "2c"}, "snmp_secrets": {"community": "s3cr3t-comm"}})
    assert r.status_code == 201, r.text
    assert "s3cr3t-comm" not in r.text and {c["type"] for c in r.json()["checks"]} == {"icmp", "snmp"}
    v3 = await client.post(f"{API}/network-devices", headers=a.headers, json={
        "name": "fw", "host": "10.0.0.3", "ping": False, "snmp": {"version": "3"}})
    assert v3.status_code == 422  # v3 requires username
    svc = await client.post(f"{API}/services", headers=a.headers, json={
        "name": "orders-db", "kind": "database", "checks": [
            {"name": "Postgres", "type": "postgres", "config": {"host": "10.0.0.9", "username": "monitor",
                                                                 "database": "orders", "query": "SELECT 1"},
             "secrets": {"password": "pw"}},
            {"name": "Redis", "type": "redis", "config": {"host": "10.0.0.10"}}]})
    assert svc.status_code == 201, svc.text
    bad = await client.post(f"{API}/services", headers=a.headers, json={
        "name": "x", "checks": [{"name": "q", "type": "mysql", "config": {"host": "10.0.0.9", "query": "DROP TABLE x"}}]})
    assert bad.status_code == 422
    lst = (await client.get(f"{API}/services", headers=a.headers)).json()
    assert lst["total"] == 1 and lst["items"][0]["checks"][0]["has_secrets"] is True


async def test_groups_dependencies_and_import(client):
    a = await make_actor(client)
    g1 = (await client.post(f"{API}/groups", headers=a.headers, json={"name": "EU"})).json()
    g2 = (await client.post(f"{API}/groups", headers=a.headers, json={"name": "Frankfurt", "parent_id": g1["id"]})).json()
    cyc = await client.put(f"{API}/groups/{g1['id']}", headers=a.headers, json={"name": "EU", "parent_id": g2["id"]})
    assert cyc.status_code == 422
    imp = await client.post(f"{API}/resources/import", headers=a.headers, json={"items": [
        {"kind": "server", "name": "app-1", "group_id": g2["id"], "tags": ["app"]},
        {"kind": "server", "name": "app-2"},
        {"kind": "website", "name": "bad", "checks": [{"name": "h", "type": "http", "config": {"url": "gopher://x"}}]},
        {"kind": "nonsense", "name": "zzz"},
    ]})
    body = imp.json()
    assert body["created"] == 2 and [e["index"] for e in body["errors"]] == [2, 3]
    dry = await client.post(f"{API}/resources/import", headers=a.headers,
                            json={"items": [{"kind": "server", "name": "app-3"}], "dry_run": True})
    assert dry.json()["created"] == 0
    ids = body["ids"]
    dep = await client.post(f"{API}/resources/{ids[0]}/dependencies", headers=a.headers, json={"depends_on_id": ids[1]})
    assert dep.status_code == 201
    cyc = await client.post(f"{API}/resources/{ids[1]}/dependencies", headers=a.headers, json={"depends_on_id": ids[0]})
    assert cyc.status_code == 422
    graph = (await client.get(f"{API}/resources/dependency-map", headers=a.headers)).json()
    assert len(graph["nodes"]) == 2 and len(graph["edges"]) == 1
    groups = (await client.get(f"{API}/groups", headers=a.headers)).json()
    assert {g["name"]: g["resource_count"] for g in groups} == {"EU": 0, "Frankfurt": 1}
    assert (await client.delete(f"{API}/resources/{ids[0]}", headers=a.headers)).status_code == 200
    assert (await client.get(f"{API}/resources/{ids[0]}", headers=a.headers)).status_code == 404


async def test_pause_monitoring_sets_unknown(client):
    a = await make_actor(client)
    site = (await client.post(f"{API}/websites", headers=a.headers, json={"name": "p", "url": "https://example.com"})).json()
    r = await client.patch(f"{API}/resources/{site['id']}", headers=a.headers, json={"is_paused": True})
    assert r.json()["is_paused"] is True and r.json()["status"] == "unknown"


async def test_address_change_updates_check_target(client):
    a = await make_actor(client)
    site = (await client.post(f"{API}/websites", headers=a.headers, json={"name": "w", "url": "https://old.example.com/"})).json()
    r = await client.patch(f"{API}/resources/{site['id']}", headers=a.headers, json={"address": "https://new.example.com/h"})
    assert r.status_code == 200 and r.json()["checks"][0]["config"]["url"] == "https://new.example.com/h"
    bad = await client.patch(f"{API}/resources/{site['id']}", headers=a.headers, json={"address": "http://169.254.169.254/"})
    assert bad.status_code == 422
