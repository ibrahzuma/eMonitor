"""API conventions: error envelope, request ids, security headers, OpenAPI, read endpoints, reports."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tests.conftest import login, make_actor, make_org, make_user
from tests.helpers import feed, make_check

API = "/api/v1"


async def test_error_envelope_and_request_id(client):
    r = await client.get(f"{API}/resources")
    assert r.status_code == 401
    err = r.json()["error"]
    assert err["code"] == "unauthorized" and err["request_id"] == r.headers["X-Request-ID"]
    r = await client.get(f"{API}/nope", headers={"X-Request-ID": "trace-123"})
    assert r.status_code == 404 and r.headers["X-Request-ID"] == "trace-123"
    a = await make_actor(client)
    r = await client.post(f"{API}/websites", headers=a.headers, json={"name": ""})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    assert any("url" in d["loc"] for d in r.json()["error"]["details"])
    r = await client.get(f"{API}/resources/not-a-uuid", headers=a.headers)
    assert r.status_code == 422
    assert r.headers["X-Content-Type-Options"] == "nosniff" and r.headers["X-Frame-Options"] == "DENY"
    bad_rid = await client.get(f"{API}/health/live", headers={"X-Request-ID": "x" * 200 + "<script>"})
    assert len(bad_rid.headers["X-Request-ID"]) == 32


async def test_openapi_available(client):
    spec = (await client.get(f"{API}/openapi.json")).json()
    for p in ("/api/v1/auth/login", "/api/v1/servers", "/api/v1/websites", "/api/v1/incidents", "/api/v1/logs/search",
              "/api/v1/alerts/rules", "/api/v1/maintenance", "/api/v1/reports/{name}", "/api/v1/audit-logs",
              "/api/v1/agents/enroll", "/api/v1/network-devices", "/api/v1/services", "/api/v1/metrics/series"):
        assert p in spec["paths"], p


async def test_read_endpoints_respond_for_new_org(client):
    a = await make_actor(client)
    for path in ("/dashboard/summary", "/dashboard/trends", "/dashboard/traffic", "/dashboard/activity",
                 "/dashboard/log-errors", "/resources", "/servers", "/websites", "/network-devices", "/services",
                 "/groups", "/incidents", "/alerts/rules", "/notifications/channels", "/notifications/policies",
                 "/notifications/deliveries", "/notifications/inbox", "/maintenance", "/slos", "/users", "/teams",
                 "/api-keys", "/audit-logs", "/agents", "/agents/enrollment-tokens", "/organizations/current",
                 "/saved-searches", "/resources/dependency-map", "/logs/search", "/logs/histogram"):
        r = await client.get(API + path, headers=a.headers)
        assert r.status_code == 200, (path, r.text)


async def test_reports_json_csv_pdf(client):
    a = await make_actor(client)
    r, c = await make_check(a.org, failure_threshold=1)
    now = datetime.now(UTC)
    await feed(c, ["up", "down", "up"], start=now - timedelta(minutes=5))
    rep = (await client.get(f"{API}/reports/availability", headers=a.headers, params={"range": "24h"})).json()
    assert rep["rows"][0]["down_checks"] == 1 and rep["rows"][0]["uptime_percent"] is not None
    inc = (await client.get(f"{API}/reports/incidents", headers=a.headers)).json()
    assert inc["summary"]["total"] == 1 and inc["summary"]["mttr_seconds"] is not None
    for name in ("website-uptime", "service-availability", "alerts", "utilization", "capacity", "ssl", "log-errors", "sla"):
        assert (await client.get(f"{API}/reports/{name}", headers=a.headers)).status_code == 200, name
    csv = await client.get(f"{API}/reports/availability", headers=a.headers, params={"format": "csv"})
    assert csv.headers["content-type"].startswith("text/csv") and "Uptime %" in csv.text
    pdf = await client.get(f"{API}/reports/incidents", headers=a.headers, params={"format": "pdf"})
    assert pdf.content[:4] == b"%PDF"
    assert (await client.get(f"{API}/reports/unknown", headers=a.headers)).status_code == 404
    assert (await client.get(f"{API}/reports/availability", headers=a.headers,
                             params={"range": "bogus"})).status_code == 422


async def test_slo_crud_and_status(client):
    a = await make_actor(client)
    r, c = await make_check(a.org, failure_threshold=1)
    now = datetime.now(UTC)
    await feed(c, ["up"] * 9 + ["down"], start=now - timedelta(minutes=10))
    slo = await client.post(f"{API}/slos", headers=a.headers,
                            json={"name": "Shop availability", "resource_id": str(r.id), "target_percent": 99.0})
    assert slo.status_code == 201, slo.text
    st = slo.json()["last_status"]
    assert st["sli_percent"] == 90.0 and st["status"] == "breached"
    assert (await client.get(f"{API}/slos", headers=a.headers, params={"live": True})).json()[0]["last_status"]["bad_events"] == 1


async def test_org_settings_validation(client):
    a = await make_actor(client)
    ok = await client.patch(f"{API}/organizations/current", headers=a.headers, json={
        "settings": {"agent_timeout_seconds": 300, "ssl_alert_days": [7, 30]},
        "thresholds": {"cpu_percent": {"warning": 70, "critical": 90}}, "timezone": "Europe/Berlin"})
    assert ok.status_code == 200 and ok.json()["settings"]["ssl_alert_days"] == [30, 7]
    for bad in ({"settings": {"unknown_key": 1}}, {"settings": {"agent_timeout_seconds": 1}},
                {"thresholds": {"cpu_percent": {"warning": 95, "critical": 90}}}, {"timezone": "Mars/Base"}):
        assert (await client.patch(f"{API}/organizations/current", headers=a.headers, json=bad)).status_code == 422
    viewer = await make_actor(client, role="viewer", org=a.org)
    assert (await client.patch(f"{API}/organizations/current", headers=viewer.headers,
                               json={"name": "x y"})).status_code == 403


async def test_member_and_team_management(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/users", headers=a.headers,
                          json={"email": "ops@example.com", "full_name": "Ops", "role": "operator",
                                "password": "Operator-Pass-1"})
    assert r.status_code == 201
    uid = r.json()["user_id"]
    assert (await login(client, "ops@example.com", "Operator-Pass-1"))
    t = await client.post(f"{API}/teams", headers=a.headers, json={"name": "SRE", "member_ids": [uid]})
    assert t.status_code == 201
    stranger = await make_user(await make_org())
    bad = await client.put(f"{API}/teams/{t.json()['id']}", headers=a.headers,
                           json={"name": "SRE", "member_ids": [str(stranger.id)]})
    assert bad.status_code == 422
    d = await client.patch(f"{API}/users/{uid}", headers=a.headers, json={"is_active": False})
    assert d.json()["is_active"] is False
    r = await client.post(f"{API}/auth/login", json={"email": "ops@example.com", "password": "Operator-Pass-1"})
    assert r.status_code == 401
