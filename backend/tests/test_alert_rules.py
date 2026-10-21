"""Alert rule engine: consecutive breaches, recovery, cooldown, log patterns, composite rules."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from app.alerts.evaluator import evaluate_rule
from app.core import events
from app.core.db import get_sessionmaker
from app.models import AlertRule, AlertRuleState, Resource
from tests.conftest import make_actor, make_api_key, make_org
from tests.helpers import incidents

API = "/api/v1"


async def make_server(org) -> Resource:
    async with get_sessionmaker()() as s:
        r = Resource(organization_id=org.id, kind="server", name=f"srv-{uuid.uuid4().hex[:5]}", tags=["db"])
        s.add(r)
        await s.commit()
        return r


async def run_rule(rule_id, now):
    async with get_sessionmaker()() as db:
        rule = await db.get(AlertRule, rule_id)
        out = await evaluate_rule(db, rule, now)
        await events.commit(db)
        return out


async def put_metric(store, org, res, metric, value, ts, instance=""):
    await store.insert("metrics", [{"ts": ts, "org_id": org.id, "resource_id": res.id, "metric": metric,
                                    "instance": instance, "value": value}])


async def test_metric_threshold_rule_lifecycle(client, store):
    a = await make_actor(client)
    srv = await make_server(a.org)
    r = await client.post(f"{API}/alerts/rules", headers=a.headers, json={
        "name": "High memory", "rule_type": "metric_threshold", "target": {"tags": ["db"]},
        "condition": {"metric": "memory_percent", "aggregation": "avg", "operator": "gt", "threshold": 90,
                      "window_seconds": 300},
        "severity": "high", "consecutive_breaches": 2, "recovery_consecutive": 1, "cooldown_seconds": 600})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    now = datetime.now(UTC)
    await put_metric(store, a.org, srv, "memory_percent", 95, now - timedelta(seconds=30))
    assert (await run_rule(rid, now)) == {"pending": 1}
    assert await incidents(a.org.id) == []
    assert (await run_rule(rid, now + timedelta(seconds=1))) == {"fired": 1}
    incs = await incidents(a.org.id)
    assert len(incs) == 1 and incs[0].severity == "high" and incs[0].alert_rule_id == uuid.UUID(rid)
    assert (await run_rule(rid, now + timedelta(seconds=2))) == {"firing": 1}
    assert len(await incidents(a.org.id)) == 1
    store.tables["metrics"].clear()
    await put_metric(store, a.org, srv, "memory_percent", 40, now + timedelta(seconds=3))
    assert (await run_rule(rid, now + timedelta(seconds=4))) == {"resolved": 1}
    assert (await incidents(a.org.id))[0].status == "resolved"
    # cooldown: breach again right away stays pending
    store.tables["metrics"].clear()
    await put_metric(store, a.org, srv, "memory_percent", 99, now - timedelta(seconds=2))
    await run_rule(rid, now + timedelta(seconds=6))
    assert (await run_rule(rid, now + timedelta(seconds=7))) == {"cooldown": 1}
    states = (await client.get(f"{API}/alerts/rules/{rid}/states", headers=a.headers)).json()
    assert states[0]["state"] == "pending"
    preview = (await client.post(f"{API}/alerts/rules/{rid}/preview", headers=a.headers)).json()
    assert preview[0]["breached"] is True and preview[0]["value"] == 99


async def test_log_pattern_rule(client, store):
    a = await make_actor(client)
    key = await make_api_key(a.org, scopes=["logs:write"])
    await client.post(f"{API}/logs/ingest", headers={"X-API-Key": key},
                      json={"records": [{"message": "OutOfMemoryError in worker", "severity": "error"}] * 3})
    r = await client.post(f"{API}/alerts/rules", headers=a.headers, json={
        "name": "OOM", "rule_type": "log_pattern",
        "condition": {"query": "OutOfMemoryError", "operator": "gte", "threshold": 3, "window_seconds": 300},
        "severity": "critical"})
    assert (await run_rule(r.json()["id"], datetime.now(UTC))) == {"fired": 1}
    inc = (await incidents(a.org.id))[0]
    assert inc.source == "rule" and "3 log events" in inc.trigger_condition


async def test_error_rate_and_missing_telemetry_rules(client, store):
    a = await make_actor(client)
    srv = await make_server(a.org)
    now = datetime.now(UTC)
    r = await client.post(f"{API}/alerts/rules", headers=a.headers, json={
        "name": "No CPU data", "rule_type": "missing_telemetry", "target": {"resource_ids": [str(srv.id)]},
        "condition": {"metric": "cpu_percent", "window_seconds": 120}})
    assert (await run_rule(r.json()["id"], now)) == {"fired": 1}
    await put_metric(store, a.org, srv, "cpu_percent", 5, now - timedelta(seconds=10))
    assert (await run_rule(r.json()["id"], now + timedelta(seconds=1))) == {"resolved": 1}


async def test_composite_rule_and_validation(client):
    a = await make_actor(client)
    bad = await client.post(f"{API}/alerts/rules", headers=a.headers, json={
        "name": "bad", "rule_type": "metric_threshold", "condition": {"metric": "cpu_percent"}})
    assert bad.status_code == 422  # threshold missing
    ids = []
    for n in ("a", "b"):
        r = await client.post(f"{API}/alerts/rules", headers=a.headers, json={
            "name": n, "rule_type": "agent_disconnected", "condition": {"seconds": 60}})
        ids.append(r.json()["id"])
    comp = await client.post(f"{API}/alerts/rules", headers=a.headers, json={
        "name": "both", "rule_type": "composite", "condition": {"operator": "and", "rule_ids": ids}})
    assert comp.status_code == 201
    async with get_sessionmaker()() as s:
        s.add(AlertRuleState(rule_id=uuid.UUID(ids[0]), subject_key="x", organization_id=a.org.id, state="firing"))
        await s.commit()
    assert (await run_rule(comp.json()["id"], datetime.now(UTC))) == {"ok": 1}
    async with get_sessionmaker()() as s:
        s.add(AlertRuleState(rule_id=uuid.UUID(ids[1]), subject_key="y", organization_id=a.org.id, state="firing"))
        await s.commit()
    assert (await run_rule(comp.json()["id"], datetime.now(UTC))) == {"fired": 1}
    other = await make_org()
    from tests.conftest import login, make_user

    u = await make_user(other)
    h = {"Authorization": f"Bearer {await login(client, u.email)}"}
    cross = await client.post(f"{API}/alerts/rules", headers=h, json={
        "name": "x", "rule_type": "composite", "condition": {"operator": "or", "rule_ids": ids}})
    assert cross.status_code == 422
