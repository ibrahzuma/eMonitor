"""Check evaluation state machine and incident lifecycle (dedup, auto-resolve, reopen, idempotency)."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from app.core import events
from app.core.db import get_sessionmaker
from app.incidents import engine
from app.models import Check, IncidentEvent, Organization, Resource
from tests.conftest import make_actor, make_org
from tests.helpers import T0, count, feed, incidents, make_check

API = "/api/v1"


async def test_failures_below_threshold_do_not_open_incident():
    org = await make_org()
    _, c = await make_check(org, failure_threshold=3)
    await feed(c, ["up", "down", "down", "up", "down", "down"])
    assert await incidents(org.id) == []


async def test_repeated_failures_update_single_incident():
    org = await make_org()
    r, c = await make_check(org, failure_threshold=2)
    await feed(c, ["up"] + ["down"] * 50)
    incs = await incidents(org.id)
    assert len(incs) == 1
    inc = incs[0]
    assert inc.status == "triggered" and inc.severity == "critical"
    assert inc.occurrence_count == 49  # threshold reached at the 2nd failure, then 48 updates
    assert inc.dedup_key == f"check:{c.id}"
    assert inc.evidence["condition_started_at"] == (T0 + timedelta(seconds=60)).isoformat()
    async with get_sessionmaker()() as s:
        res = await s.get(Resource, r.id)
        assert res.status == "critical"
    # timeline is not flooded with one event per failure
    assert await count(IncidentEvent, IncidentEvent.incident_id == inc.id) <= 3


async def test_recovery_auto_resolves_and_return_reopens_within_window():
    org = await make_org()
    r, c = await make_check(org)
    await feed(c, ["down", "down", "down", "up"])
    inc = (await incidents(org.id))[0]
    assert inc.status == "resolved" and inc.resolved_at is not None and inc.resolution.startswith("Recovered")
    async with get_sessionmaker()() as s:
        assert (await s.get(Resource, r.id)).status == "healthy"
    # Condition returns 10 minutes later (default reopen window 60 min) → same incident reopened
    await feed(c, ["down", "down"], start=T0 + timedelta(minutes=10))
    incs = await incidents(org.id)
    assert len(incs) == 1 and incs[0].status == "reopened" and incs[0].reopen_count == 1
    # Recover, then fail again after the reopen window → a new incident
    await feed(c, ["up"], start=T0 + timedelta(minutes=20))
    await feed(c, ["down", "down"], start=T0 + timedelta(hours=3))
    incs = await incidents(org.id)
    assert len(incs) == 2 and incs[1].status == "triggered" and incs[1].number == incs[0].number + 1


async def test_duplicate_and_stale_slots_are_ignored():
    org = await make_org()
    _, c = await make_check(org, failure_threshold=1)
    first = await feed(c, ["down"])
    dup = await feed(c, ["down"])  # same slot T0 again (e.g. Celery redelivery)
    assert "ignored" not in first[0] and dup[0]["ignored"] == "duplicate or stale slot"
    async with get_sessionmaker()() as s:
        assert (await s.get(Check, c.id)).consecutive_failures == 1
    assert (await incidents(org.id))[0].occurrence_count == 1


async def test_unknown_outcomes_never_change_state():
    org = await make_org()
    _, c = await make_check(org, failure_threshold=2)
    await feed(c, ["down", "unknown", "unknown", "down"])
    async with get_sessionmaker()() as s:
        chk = await s.get(Check, c.id)
        assert chk.consecutive_failures == 2 and chk.state == "critical"


async def test_concurrent_raises_create_one_incident():
    org = await make_org()

    async def raise_once(i: int):
        async with get_sessionmaker()() as db:
            o = await db.get(Organization, org.id)
            await engine.raise_condition(db, org=o, dedup_key="race:1", title="Race", severity="warning",
                                         source="manual")
            await events.commit(db)

    await asyncio.gather(*(raise_once(i) for i in range(8)), return_exceptions=False)
    incs = await incidents(org.id)
    assert len(incs) == 1 and incs[0].occurrence_count == 8


async def test_severity_escalation_on_existing_incident():
    org = await make_org()
    async with get_sessionmaker()() as db:
        o = await db.get(Organization, org.id)
        await engine.raise_condition(db, org=o, dedup_key="k", title="t", severity="warning", source="manual")
        res = await engine.raise_condition(db, org=o, dedup_key="k", title="t", severity="critical", source="manual")
        await events.commit(db)
    assert res.action == "renotify" and res.incident.severity == "critical"


async def test_ssl_expiry_thresholds_raise_and_clear():
    org = await make_org()
    _, c = await make_check(org)
    cert = {"subject": "example.com", "issuer": "CA", "not_after": "x", "serial": "1"}
    await feed(c, ["up"], details={"certificate": {**cert, "days_remaining": 45}})
    assert await incidents(org.id) == []
    await feed(c, ["up"], start=T0 + timedelta(minutes=1), details={"certificate": {**cert, "days_remaining": 20}})
    incs = await incidents(org.id)
    assert len(incs) == 1 and incs[0].source == "ssl" and incs[0].severity == "warning"
    await feed(c, ["up"], start=T0 + timedelta(minutes=2), details={"certificate": {**cert, "days_remaining": 2}})
    incs = await incidents(org.id)
    assert len(incs) == 1 and incs[0].severity == "critical" and incs[0].evidence["renotify_marker"] == "ssl:3"
    await feed(c, ["up"], start=T0 + timedelta(minutes=3), details={"certificate": {**cert, "days_remaining": 89}})
    assert (await incidents(org.id))[0].status == "resolved"


async def test_incident_lifecycle_via_api(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/incidents", headers=a.headers,
                          json={"title": "DB failover", "severity": "high", "description": "manual"})
    assert r.status_code == 201
    inc = r.json()
    assert inc["number"] == 1 and inc["status"] == "triggered"
    iid = inc["id"]
    d = (await client.post(f"{API}/incidents/{iid}/acknowledge", headers=a.headers, json={"note": "on it"})).json()
    assert d["status"] == "acknowledged" and d["assignee_id"] == str(a.user.id)
    assert (await client.post(f"{API}/incidents/{iid}/acknowledge", headers=a.headers)).status_code == 422
    d = (await client.post(f"{API}/incidents/{iid}/investigate", headers=a.headers)).json()
    assert d["status"] == "investigating"
    d = (await client.post(f"{API}/incidents/{iid}/comments", headers=a.headers, json={"note": "found it"})).json()
    assert any(e["kind"] == "comment" and e["message"] == "found it" for e in d["timeline"])
    assert (await client.post(f"{API}/incidents/{iid}/assign", headers=a.headers,
                              json={"assignee_id": "00000000-0000-0000-0000-000000000001"})).status_code == 422
    d = (await client.post(f"{API}/incidents/{iid}/resolve", headers=a.headers, json={"resolution": "fixed"})).json()
    assert d["status"] == "resolved" and d["resolution"] == "fixed"
    d = (await client.post(f"{API}/incidents/{iid}/reopen", headers=a.headers)).json()
    assert d["status"] == "reopened"
    kinds = [e["kind"] for e in d["timeline"]]
    assert kinds[:2] == ["created", "acknowledged"] and "resolved" in kinds and kinds[-1] == "reopened"
    lst = (await client.get(f"{API}/incidents", headers=a.headers, params={"q": "INC-1"})).json()
    assert lst["total"] == 1
    csv = await client.get(f"{API}/incidents/export", headers=a.headers)
    assert csv.status_code == 200 and "INC-1" in csv.text


async def test_bulk_acknowledge_requires_permission(client):
    org = await make_org()
    admin = await make_actor(client, org=org)
    ids = [(await client.post(f"{API}/incidents", headers=admin.headers, json={"title": f"incident {i}"})).json()["id"]
           for i in range(3)]
    op = await make_actor(client, role="operator", org=org)
    assert (await client.post(f"{API}/incidents/bulk", headers=op.headers,
                              json={"ids": ids, "action": "acknowledge"})).status_code == 403
    r = await client.post(f"{API}/incidents/bulk", headers=admin.headers, json={"ids": ids, "action": "acknowledge"})
    assert r.json()["updated"] == 3
