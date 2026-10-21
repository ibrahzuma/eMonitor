"""Log ingestion, search, pagination, quotas and ClickHouse query safety."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.telemetry.store import LogQuery, _log_where, decode_cursor, encode_cursor, tokenize_query
from tests.conftest import make_actor, make_api_key, make_org

API = "/api/v1"


async def ingest(client, key, records):
    return await client.post(f"{API}/logs/ingest", headers={"X-API-Key": key}, json={"records": records})


async def test_http_ingestion_requires_logs_write_scope(client):
    org = await make_org()
    viewer_key = await make_api_key(org, role="viewer")
    r = await ingest(client, viewer_key, [{"message": "hi"}])
    assert r.status_code == 403
    key = await make_api_key(org, role="it_admin", scopes=["logs:write"])
    r = await ingest(client, key, [{"message": "hi"}])
    assert r.status_code == 202 and r.json()["accepted"] == 1


async def test_search_filters_and_cursor_pagination(client):
    a = await make_actor(client)
    key = await make_api_key(a.org, role="it_admin", scopes=["logs:write"])
    now = datetime.now(UTC)
    recs = [{"ts": (now - timedelta(seconds=i)).isoformat(), "message": f"request {i} completed status=200",
             "severity": "info", "application": "api", "host": "web-01", "attributes": {"route": "/users"}}
            for i in range(25)]
    recs += [{"ts": (now - timedelta(seconds=100)).isoformat(), "message": "Database connection refused: timeout",
              "severity": "ERR", "application": "worker", "host": "web-02", "trace_id": "trace-abc",
              "attributes": {"route": "/jobs"}}]
    assert (await ingest(client, key, recs)).status_code == 202
    s = (await client.get(f"{API}/logs/search", headers=a.headers, params={"q": "connection refused"})).json()
    assert len(s["items"]) == 1 and s["items"][0]["severity"] == "error"
    s = (await client.get(f"{API}/logs/search", headers=a.headers, params={"q": '"status=200"', "limit": 10})).json()
    assert len(s["items"]) == 10 and s["next_cursor"]
    seen = {x["id"] for x in s["items"]}
    cursor = s["next_cursor"]
    while cursor:
        page = (await client.get(f"{API}/logs/search", headers=a.headers,
                                 params={"q": '"status=200"', "limit": 10, "cursor": cursor})).json()
        assert not seen & {x["id"] for x in page["items"]}
        seen |= {x["id"] for x in page["items"]}
        cursor = page["next_cursor"]
    assert len(seen) == 25
    assert len((await client.get(f"{API}/logs/search", headers=a.headers,
                                 params={"trace_id": "trace-abc"})).json()["items"]) == 1
    assert len((await client.get(f"{API}/logs/search", headers=a.headers,
                                 params={"attr": "route=/jobs"})).json()["items"]) == 1
    assert len((await client.get(f"{API}/logs/search", headers=a.headers,
                                 params={"min_severity": "warning"})).json()["items"]) == 1
    assert len((await client.get(f"{API}/logs/search", headers=a.headers,
                                 params={"application": "api", "host": "web-01"})).json()["items"]) == 25
    hist = (await client.get(f"{API}/logs/histogram", headers=a.headers)).json()
    assert sum(p["count"] for p in hist["points"]) == 26
    facets = (await client.get(f"{API}/logs/facets", headers=a.headers, params={"field": "application"})).json()
    assert facets[0] == {"value": "api", "count": 25}
    csv = await client.get(f"{API}/logs/export", headers=a.headers, params={"q": "refused"})
    assert "Database connection refused" in csv.text


async def test_logs_are_tenant_isolated(client):
    a = await make_actor(client)
    b = await make_actor(client)
    key = await make_api_key(a.org, scopes=["logs:write"])
    await ingest(client, key, [{"message": "secret thing in org a"}])
    assert (await client.get(f"{API}/logs/search", headers=b.headers, params={"q": "secret"})).json()["items"] == []


async def test_log_quota_enforced(client):
    a = await make_actor(client)
    await client.patch(f"{API}/organizations/current", headers=a.headers, json={"settings": {"logs_per_day_quota": 3}})
    key = await make_api_key(a.org, scopes=["logs:write"])
    assert (await ingest(client, key, [{"message": "a"}, {"message": "b"}])).status_code == 202
    r = await ingest(client, key, [{"message": "c"}, {"message": "d"}])
    assert r.status_code == 429


async def test_saved_searches(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/saved-searches", headers=a.headers,
                          json={"name": "errors", "query": {"min_severity": "error"}})
    assert r.status_code == 201
    other = await make_actor(client, org=a.org, role="viewer")
    assert (await client.get(f"{API}/saved-searches", headers=other.headers)).json() == []
    assert len((await client.get(f"{API}/saved-searches", headers=a.headers)).json()) == 1


def test_clickhouse_log_query_is_parameterized():
    hostile = "x' OR 1=1 --"
    q = LogQuery(start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 1, 2, tzinfo=UTC),
                 text=f'error "{hostile}" {hostile}', severities=["error'"], hosts=["h'"],
                 attributes={"k'ey": "v'al"}, trace_id="t'")
    params: dict = {"org": "o"}
    sql = _log_where(q, params)
    assert "'" not in sql and "OR 1=1" not in sql
    assert hostile in params.values()
    assert "hasToken(lower(message), {tok0:String})" in sql


def test_tokenizer_and_cursor_roundtrip():
    tokens, phrases = tokenize_query('Error "disk full" user=bob timeout')
    assert tokens == ["error", "timeout"] and phrases == ["disk full", "user=bob"]
    import uuid

    ts = datetime(2026, 1, 1, 12, tzinfo=UTC)
    u = uuid.uuid4()
    assert decode_cursor(encode_cursor(ts, u)) == (ts, u)
    assert decode_cursor("garbage!!") is None
