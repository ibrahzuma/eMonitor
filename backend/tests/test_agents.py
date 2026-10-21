"""Agent enrollment, credential lifecycle, telemetry ingestion and threshold evaluation."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.core import events
from app.core.db import get_sessionmaker
from app.models import Agent, Resource, ServerDetail
from app.monitoring.evaluator import evaluate_agent_liveness
from app.telemetry import ingest
from tests.conftest import make_actor
from tests.helpers import incidents

API = "/api/v1"


async def enroll(client, actor, **token_kw):
    t = await client.post(f"{API}/agents/enrollment-tokens", headers=actor.headers, json=token_kw)
    assert t.status_code == 201, t.text
    token = t.json()["token"]
    r = await client.post(f"{API}/agents/enroll", json={
        "token": token, "hostname": "web-01", "agent_version": "1.0.0", "os_version": "Ubuntu 24.04",
        "kernel": "6.8.0", "cpu_count": 4, "memory_total_bytes": 8 * 2**30})
    assert r.status_code == 201, r.text
    return token, r.json()


def agent_auth(enrolled) -> dict:
    return {"Authorization": f"Agent {enrolled['agent_id']}.{enrolled['agent_secret']}"}


def sample(ts: datetime, cpu: float, mem: float = 40.0, disk: float = 50.0, nginx_up: float = 1.0) -> dict:
    return {"ts": ts.isoformat(), "metrics": [
        {"m": "cpu_percent", "v": cpu}, {"m": "memory_percent", "v": mem}, {"m": "load1", "v": 0.5},
        {"m": "disk_percent", "i": "/", "v": disk}, {"m": "net_rx_bytes_ps", "i": "eth0", "v": 1200.0},
        {"m": "service_up", "i": "nginx", "v": nginx_up}, {"m": "uptime_seconds", "v": 3600}]}


async def push(client, enrolled, samples, **extra):
    return await client.post(f"{API}/agents/metrics", headers=agent_auth(enrolled),
                             json={"agent_version": "1.0.0", "hostname": "web-01", "samples": samples, **extra})


async def test_enrollment_creates_server_and_token_is_single_use(client):
    a = await make_actor(client)
    token, enrolled = await enroll(client, a, environment="staging", tags=["web"])
    async with get_sessionmaker()() as s:
        r = await s.get(Resource, enrolled["server_id"])
        sd = await s.get(ServerDetail, r.id)
        assert r.kind == "server" and r.name == "web-01" and r.environment == "staging" and r.tags == ["web"]
        assert sd.cpu_count == 4 and sd.os_version == "Ubuntu 24.04"
        agent = await s.get(Agent, enrolled["agent_id"])
        assert agent.secret_hash != enrolled["agent_secret"]  # stored hashed
    again = await client.post(f"{API}/agents/enroll", json={"token": token, "hostname": "web-02"})
    assert again.status_code == 401
    assert (await client.post(f"{API}/agents/enroll", json={"token": "emt_bogus_token_value", "hostname": "x"})).status_code == 401


async def test_enrollment_requires_permission(client):
    from tests.conftest import make_org

    org = await make_org()
    viewer = await make_actor(client, role="viewer", org=org)
    r = await client.post(f"{API}/agents/enrollment-tokens", headers=viewer.headers, json={})
    assert r.status_code == 403


async def test_metric_ingestion_stores_telemetry_and_snapshot(client, store):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    now = datetime.now(UTC)
    r = await push(client, enrolled, [sample(now - timedelta(seconds=30), 12.5), sample(now, 15.0)],
                   system={"uptime_seconds": 3600})
    assert r.status_code == 202 and r.json()["accepted"] == 14
    assert len(store.tables["metrics"]) == 14
    res = (await client.get(f"{API}/servers/{enrolled['server_id']}".replace("/servers/", "/resources/"),
                            headers=a.headers)).json()
    assert res["server"]["latest"]["cpu_percent"] == 15.0 and res["server"]["latest"]["disks"] == {"/": 50.0}
    assert res["agent"]["status"] == "active" and res["agent"]["last_seen_at"]
    assert res["status"] == "healthy"  # first contact from the agent establishes health
    series = (await client.get(f"{API}/metrics/series", headers=a.headers,
                               params={"resource_id": enrolled["server_id"], "metric": "cpu_percent", "range": "1h"})).json()
    values = [p[1] for s in series["series"] for p in s["points"]]
    assert values and 12.5 <= sum(values) / len(values) <= 15.0


async def test_invalid_samples_rejected_or_dropped(client, store):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    bad = await push(client, enrolled, [{"ts": datetime.now(UTC).isoformat(), "metrics": [{"m": "CPU; DROP", "v": 1}]}])
    assert bad.status_code == 422
    old = await push(client, enrolled, [sample(datetime.now(UTC) - timedelta(days=3), 10)])
    assert old.status_code == 202 and old.json()["accepted"] == 0


async def test_cpu_threshold_incident_after_consecutive_samples_and_recovery(client):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    now = datetime.now(UTC)
    await push(client, enrolled, [sample(now - timedelta(seconds=60), 97)])
    assert [i for i in await incidents(a.org.id) if i.source == "metric"] == []  # needs 2 consecutive samples
    await push(client, enrolled, [sample(now - timedelta(seconds=30), 98)])
    incs = [i for i in await incidents(a.org.id) if i.source == "metric"]
    assert len(incs) == 1 and incs[0].severity == "critical" and "CPU" in incs[0].title
    await push(client, enrolled, [sample(now - timedelta(seconds=20), 99)])
    assert len([i for i in await incidents(a.org.id) if i.source == "metric"]) == 1
    async with get_sessionmaker()() as s:
        assert (await s.get(Resource, enrolled["server_id"])).status == "critical"
    await push(client, enrolled, [sample(now - timedelta(seconds=10), 20)])
    await push(client, enrolled, [sample(now, 21)])
    incs = [i for i in await incidents(a.org.id) if i.source == "metric"]
    assert incs[0].status == "resolved"
    async with get_sessionmaker()() as s:
        assert (await s.get(Resource, enrolled["server_id"])).status == "healthy"


async def test_per_server_threshold_override(client):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    r = await client.patch(f"{API}/servers/{enrolled['server_id']}", headers=a.headers,
                           json={"thresholds": {"cpu_percent": {"warning": 30, "critical": 50}}})
    assert r.status_code == 200
    now = datetime.now(UTC)
    await push(client, enrolled, [sample(now - timedelta(seconds=10), 40)])
    await push(client, enrolled, [sample(now, 41)])
    inc = [i for i in await incidents(a.org.id) if i.source == "metric"][0]
    assert inc.severity == "warning"


async def test_stopped_service_raises_incident(client):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    await push(client, enrolled, [sample(datetime.now(UTC), 10, nginx_up=0)])
    inc = [i for i in await incidents(a.org.id) if i.dedup_key.startswith("service:")]
    assert inc and "nginx" in inc[0].title
    await push(client, enrolled, [sample(datetime.now(UTC), 10, nginx_up=1)])
    assert [i for i in await incidents(a.org.id) if i.dedup_key.startswith("service:")][0].status == "resolved"


async def test_agent_liveness_marks_unreachable_and_recovers(client):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    await push(client, enrolled, [sample(datetime.now(UTC), 10)])
    async with get_sessionmaker()() as db:
        assert await evaluate_agent_liveness(db, now=datetime.now(UTC) + timedelta(seconds=60)) == 0
        assert await evaluate_agent_liveness(db, now=datetime.now(UTC) + timedelta(seconds=400)) == 1
        await events.commit(db)
    async with get_sessionmaker()() as s:
        assert (await s.get(Resource, enrolled["server_id"])).status == "unreachable"
    hb = await client.post(f"{API}/agents/heartbeat", headers=agent_auth(enrolled), json={"spool_depth": 3})
    assert hb.status_code == 200
    inc = [i for i in await incidents(a.org.id) if i.source == "agent"][0]
    assert inc.status == "resolved"


async def test_credential_rotation_grace_and_revocation(client):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    rot = await client.post(f"{API}/agents/rotate", headers=agent_auth(enrolled))
    assert rot.status_code == 200
    new = {"agent_id": enrolled["agent_id"], "agent_secret": rot.json()["agent_secret"]}
    # old secret still valid during grace period, new one works
    assert (await client.post(f"{API}/agents/heartbeat", headers=agent_auth(enrolled), json={})).status_code == 200
    assert (await client.post(f"{API}/agents/heartbeat", headers=agent_auth(new), json={})).status_code == 200
    async with get_sessionmaker()() as s:
        ag = await s.get(Agent, enrolled["agent_id"])
        ag.previous_secret_valid_until = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()
    assert (await client.post(f"{API}/agents/heartbeat", headers=agent_auth(enrolled), json={})).status_code == 401
    assert (await client.post(f"{API}/agents/{enrolled['agent_id']}/revoke", headers=a.headers)).status_code == 200
    assert (await client.post(f"{API}/agents/heartbeat", headers=agent_auth(new), json={})).status_code == 401
    assert (await client.post(f"{API}/agents/heartbeat", headers={"Authorization": "Agent garbage"}, json={})).status_code == 401


async def test_ingest_backpressure_returns_503(client):
    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    from app.core.config import get_settings
    from app.core.redis import get_redis

    ingest.set_direct_mode(False)
    try:
        r = get_redis()
        for _ in range(3):
            await r.xadd(ingest.STREAM, {"t": "metrics", "r": "[]"})
        s = get_settings()
        old = s.ingest_high_watermark
        s.ingest_high_watermark = 2
        try:
            resp = await push(client, enrolled, [sample(datetime.now(UTC), 10)])
        finally:
            s.ingest_high_watermark = old
        assert resp.status_code == 503 and resp.headers["Retry-After"] == "30"
        ok = await push(client, enrolled, [sample(datetime.now(UTC), 10)])
        assert ok.status_code == 202
        entries = await r.xrange(ingest.STREAM)
        assert sum(1 for _, f in entries if f["t"] == "metrics") == 4  # 3 pre-filled + 1 accepted
    finally:
        ingest.set_direct_mode(True)


async def test_ingest_consumer_writes_batches(client, store):
    """Drive the Redis-stream consumer path used in production."""
    from app.core.redis import get_redis
    from app.workers.ingest import GROUP, STREAM, ensure_group, process_entries

    a = await make_actor(client)
    _, enrolled = await enroll(client, a)
    ingest.set_direct_mode(False)
    try:
        now = datetime.now(UTC)
        await push(client, enrolled, [sample(now - timedelta(seconds=10), 97)])
        await push(client, enrolled, [sample(now, 98)])
    finally:
        ingest.set_direct_mode(True)
    await ensure_group()
    r = get_redis()
    resp = await r.xreadgroup(GROUP, "test", {STREAM: ">"}, count=100)
    entries = resp[0][1]
    ids = await process_entries(entries)
    assert len(ids) >= 2 and len(store.tables["metrics"]) == 14
    assert [i for i in await incidents(a.org.id) if i.source == "metric"]  # evaluation ran post-insert


async def test_reenrollment_with_server_token_replaces_agent(client):
    a = await make_actor(client)
    _, first = await enroll(client, a)
    _, second = await enroll(client, a, server_id=first["server_id"])
    assert second["server_id"] == first["server_id"]
    async with get_sessionmaker()() as s:
        agents = (await s.scalars(select(Agent).where(Agent.server_id == first["server_id"]))).all()
        assert sorted(x.status for x in agents) == ["active", "revoked"]
