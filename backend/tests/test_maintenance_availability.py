"""Maintenance window evaluation, availability math, SLOs and scheduling."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from app.core.db import get_sessionmaker
from app.models import Check, MaintenanceWindow
from app.monitoring.runner import plan_slots, schedule_tick
from app.services import maintenance
from app.services.availability import burn_rate, compute_availability, expected_slots, slo_status
from tests.conftest import make_actor, make_org
from tests.helpers import T0, feed, make_check

API = "/api/v1"


def win(**kw) -> MaintenanceWindow:
    base = dict(name="w", starts_at=datetime(2026, 3, 2, 1, 0, tzinfo=UTC), ends_at=datetime(2026, 3, 2, 3, 0, tzinfo=UTC),
                timezone="UTC", recurrence=None, scope="organization", resource_ids=[], group_ids=[], is_active=True)
    base.update(kw)
    return MaintenanceWindow(**base)


def test_one_off_window():
    w = win()
    assert maintenance.occurrence_at(w, datetime(2026, 3, 2, 2, 0, tzinfo=UTC))
    assert maintenance.occurrence_at(w, datetime(2026, 3, 2, 3, 0, tzinfo=UTC)) is None
    assert maintenance.is_expired(w, datetime(2026, 3, 3, tzinfo=UTC))


def test_weekly_recurrence_respects_local_time_across_dst():
    # Every Sunday 02:30–03:30 Europe/Berlin (DST starts 2026-03-29)
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("Europe/Berlin")
    start = datetime(2026, 3, 1, 1, 0, tzinfo=tz)
    w = win(starts_at=start.astimezone(UTC), ends_at=(start + timedelta(hours=1)).astimezone(UTC),
            timezone="Europe/Berlin", recurrence={"freq": "weekly", "interval": 1, "byweekday": [6]})
    winter = datetime(2026, 3, 22, 1, 30, tzinfo=tz)
    summer = datetime(2026, 4, 5, 1, 30, tzinfo=tz)
    assert maintenance.occurrence_at(w, winter.astimezone(UTC))
    assert maintenance.occurrence_at(w, summer.astimezone(UTC))  # still 01:30 local after DST change
    assert maintenance.occurrence_at(w, datetime(2026, 4, 6, 1, 30, tzinfo=tz).astimezone(UTC)) is None
    nxt = maintenance.next_occurrence(w, datetime(2026, 4, 6, tzinfo=UTC))
    assert nxt[0].astimezone(tz).hour == 1 and nxt[0].astimezone(tz).weekday() == 6


def test_recurrence_count_expires():
    w = win(recurrence={"freq": "daily", "interval": 1, "count": 2})
    assert maintenance.occurrence_at(w, datetime(2026, 3, 3, 2, tzinfo=UTC))
    assert maintenance.occurrence_at(w, datetime(2026, 3, 4, 2, tzinfo=UTC)) is None
    assert maintenance.is_expired(w, datetime(2026, 3, 5, tzinfo=UTC))


def test_scope_coverage():
    rid, gid = uuid.uuid4(), uuid.uuid4()
    assert maintenance.covers(win(scope="resources", resource_ids=[rid]), rid, None)
    assert not maintenance.covers(win(scope="resources", resource_ids=[rid]), uuid.uuid4(), None)
    assert maintenance.covers(win(scope="groups", group_ids=[gid]), None, gid)
    assert maintenance.covers(win(scope="organization"), None, None)


def test_availability_unknown_is_not_up():
    a = compute_availability({"up": 50, "down": 0}, expected=100, interval=60)
    assert a.uptime_percent == 100.0 and a.coverage_percent == 50.0 and a.unknown == 50
    b = compute_availability({"up": 90, "down": 10, "maintenance": 20, "skipped": 5}, expected=125, interval=60)
    assert b.uptime_percent == 90.0 and b.downtime_seconds == 600 and b.unknown == 5
    assert compute_availability({}, expected=10, interval=60).uptime_percent is None
    assert expected_slots(T0, T0 + timedelta(hours=1), 60) == 60
    assert expected_slots(T0, T0 + timedelta(hours=1), 60, created_at=T0 + timedelta(minutes=30)) == 30


def test_slo_burn_rate():
    assert abs(burn_rate(999, 1, 99.9) - 1.0) < 1e-9
    assert round(burn_rate(986, 14, 99.9), 1) == 14.0
    window = compute_availability({"up": 9990, "down": 10}, 10000, 60)
    short = compute_availability({"up": 50, "down": 10}, 60, 60)
    st = slo_status(window, short, window, 99.9, 30, 14.4, 6.0)
    assert st.sli_percent == 99.9 and st.status == "at_risk" and st.error_budget_remaining_percent == 0.0


async def test_availability_endpoint_from_results(client, store):
    a = await make_actor(client)
    r, c = await make_check(a.org, failure_threshold=5)
    now = datetime.now(UTC)
    await feed(c, ["up"] * 8 + ["down"] * 2, start=now - timedelta(minutes=10))
    body = (await client.get(f"{API}/resources/{r.id}/availability", headers=a.headers, params={"range": "1h"})).json()
    assert body["resource"]["uptime_percent"] == 80.0 and body["resource"]["down"] == 2


def test_plan_slots_records_missed():
    nxt = T0
    slot, missed, new = plan_slots(nxt, 60, T0 + timedelta(seconds=30))
    assert slot == T0 and missed == [] and new == T0 + timedelta(seconds=60)
    slot, missed, new = plan_slots(nxt, 60, T0 + timedelta(minutes=5, seconds=10))
    assert slot == T0 + timedelta(minutes=5) and len(missed) == 5 and new == T0 + timedelta(minutes=6)


async def test_scheduler_tick_dispatches_once_and_records_skipped(store):
    org = await make_org()
    _, c = await make_check(org, interval=60)
    sent = []
    from app.core.db import get_sessionmaker as sm

    now = T0 + timedelta(minutes=3, seconds=5)
    stats = await schedule_tick(sm(), lambda cid, slot: sent.append((cid, slot)), now=now)
    assert stats == {"dispatched": 1, "missed": 3, "deferred": 0}
    assert sent == [(c.id, T0 + timedelta(minutes=3))]
    assert sorted(r["status"] for r in store.tables["check_results"]) == ["skipped"] * 3
    stats = await schedule_tick(sm(), lambda cid, slot: sent.append((cid, slot)), now=now)
    assert stats["dispatched"] == 0  # not due again until next slot
    async with get_sessionmaker()() as s:
        assert (await s.get(Check, c.id)).next_run_at == T0 + timedelta(minutes=4)
    deferred = await schedule_tick(sm(), lambda *_: None, now=now + timedelta(minutes=5), queue_depth=10**9)
    assert deferred["deferred"] == 1


async def test_maintenance_api_and_status(client):
    a = await make_actor(client)
    site = (await client.post(f"{API}/websites", headers=a.headers, json={"name": "s", "url": "https://example.com"})).json()
    now = datetime.now(UTC)
    r = await client.post(f"{API}/maintenance", headers=a.headers, json={
        "name": "deploy", "starts_at": (now - timedelta(minutes=5)).isoformat(),
        "ends_at": (now + timedelta(hours=1)).isoformat(), "scope": "resources", "resource_ids": [site["id"]]})
    assert r.status_code == 201 and r.json()["active_now"] is True
    assert (await client.get(f"{API}/resources/{site['id']}", headers=a.headers)).json()["status"] == "maintenance"
    end = await client.post(f"{API}/maintenance/{r.json()['id']}/end", headers=a.headers)
    assert end.json()["active_now"] is False
    assert (await client.get(f"{API}/resources/{site['id']}", headers=a.headers)).json()["status"] != "maintenance"
    bad = await client.post(f"{API}/maintenance", headers=a.headers, json={
        "name": "x", "starts_at": now.isoformat(), "ends_at": (now - timedelta(hours=1)).isoformat(),
        "scope": "organization"})
    assert bad.status_code == 422
