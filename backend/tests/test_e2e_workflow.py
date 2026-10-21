"""End-to-end: a real HTTP endpoint fails → scheduled checks run → incident → webhook notification
→ endpoint recovers → incident auto-resolved → recovery notification. Only the network endpoints are
local test servers; scheduler, runner, probes, evaluator, incident engine and sender are the real code."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from aiohttp import web
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.models import Check, NotificationDelivery
from app.monitoring.runner import execute_check, schedule_tick
from app.notifications import sender
from tests.conftest import make_actor
from tests.helpers import incidents

API = "/api/v1"


@pytest.fixture
async def servers():
    state = {"status": 200}
    hooks = []

    async def site(request):
        return web.Response(status=state["status"], text="shop is open")

    async def hook(request):
        hooks.append(await request.json())
        return web.Response(status=200)

    app = web.Application()
    app.router.add_get("/", site)
    app.router.add_post("/hook", hook)
    runner = web.AppRunner(app)
    await runner.setup()
    s = web.TCPSite(runner, "127.0.0.1", 0)
    await s.start()
    port = s._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}", state, hooks
    await runner.cleanup()


async def run_cycle(now: datetime) -> None:
    sm = get_sessionmaker()
    jobs = []
    await schedule_tick(sm, lambda cid, slot: jobs.append((cid, slot)), now=now)
    for cid, slot in jobs:
        await execute_check(sm, cid, slot)
    async with sm() as db:
        ids = await sender.due_deliveries(db, now=datetime.now(UTC) + timedelta(hours=1))
    for d in ids:
        async with sm() as db:
            await sender.send_delivery(db, d, now=datetime.now(UTC) + timedelta(hours=1))


async def test_failure_to_incident_to_notification_to_recovery(client, servers, store):
    base, state, hooks = servers
    a = await make_actor(client)
    ch = await client.post(f"{API}/notifications/channels", headers=a.headers, json={
        "name": "ops-hook", "type": "webhook", "config": {"url": base + "/hook"}, "secrets": {"signing_secret": "k"}})
    assert ch.status_code == 201, ch.text
    pol = await client.post(f"{API}/notifications/policies", headers=a.headers, json={
        "name": "default", "is_default": True, "steps": [{"delay_minutes": 0, "channel_ids": [ch.json()["id"]]}]})
    assert pol.status_code == 201, pol.text
    site = await client.post(f"{API}/websites", headers=a.headers, json={
        "name": "Shop", "url": base + "/", "keyword": "open", "interval_seconds": 30, "timeout_seconds": 5,
        "failure_threshold": 2})
    assert site.status_code == 201, site.text
    check_id = site.json()["checks"][0]["id"]
    async with get_sessionmaker()() as s:
        start = (await s.get(Check, check_id)).next_run_at

    t = start
    await run_cycle(t)                       # healthy
    state["status"] = 500
    for i in range(1, 4):                    # three failing slots
        await run_cycle(t + timedelta(seconds=30 * i))
    incs = await incidents(a.org.id)
    assert len(incs) == 1 and incs[0].status == "triggered" and "HTTP 500" in incs[0].trigger_condition
    assert [h["event"] for h in hooks] == ["triggered"] and hooks[0]["incident"]["number"] == 1
    res = (await client.get(f"{API}/resources/{site.json()['id']}", headers=a.headers)).json()
    assert res["status"] == "critical" and res["open_incidents"] == 1

    state["status"] = 200
    await run_cycle(t + timedelta(seconds=120))
    incs = await incidents(a.org.id)
    assert incs[0].status == "resolved"
    assert [h["event"] for h in hooks] == ["triggered", "resolved"]
    res = (await client.get(f"{API}/resources/{site.json()['id']}", headers=a.headers)).json()
    assert res["status"] == "healthy" and res["open_incidents"] == 0

    stats = (await client.get(f"{API}/resources/{site.json()['id']}/availability", headers=a.headers,
                              params={"start": (t - timedelta(seconds=1)).isoformat(),
                                      "end": (t + timedelta(seconds=150)).isoformat()})).json()
    assert stats["resource"]["up"] == 2 and stats["resource"]["down"] == 3
    async with get_sessionmaker()() as s:
        ds = (await s.scalars(select(NotificationDelivery))).all()
        assert sorted(d.status for d in ds) == ["sent", "sent"]
    detail = (await client.get(f"{API}/incidents/{incs[0].id}", headers=a.headers)).json()
    assert [d["event"] for d in detail["deliveries"]] == ["triggered", "resolved"]
    assert {e["kind"] for e in detail["timeline"]} >= {"created", "resolved"}
