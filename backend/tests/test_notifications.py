"""Notification routing, delivery retries, deduplication, suppression and providers."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from aiohttp import web
from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.models import MaintenanceWindow, NotificationDelivery
from app.notifications import providers, sender
from app.notifications.planner import in_quiet_hours
from app.notifications.providers import DeliveryError, sign_payload
from app.workers import dispatch
from tests.conftest import make_actor, make_org
from tests.helpers import T0, feed, incidents, make_check, make_policy


async def deliveries(org_id) -> list[NotificationDelivery]:
    async with get_sessionmaker()() as s:
        return list((await s.scalars(select(NotificationDelivery).where(NotificationDelivery.organization_id == org_id)
                                     .order_by(NotificationDelivery.created_at))).all())


class FakeProvider:
    def __init__(self, fail_times: int = 0, retryable: bool = True):
        self.fail_times = fail_times
        self.retryable = retryable
        self.sent: list = []

    async def send(self, config, secrets, msg, scope):
        if self.fail_times > 0:
            self.fail_times -= 1
            raise DeliveryError("simulated outage", retryable=self.retryable)
        self.sent.append(msg)
        return "ok"


async def send_all(now: datetime | None = None) -> list[str]:
    out = []
    async with get_sessionmaker()() as db:
        ids = await sender.due_deliveries(db, now=now)
    for d in ids:
        async with get_sessionmaker()() as db:
            out.append(await sender.send_delivery(db, d, now=now))
    return out


async def test_incident_triggers_and_resolves_notifications(monkeypatch):
    org = await make_org()
    await make_policy(org)
    fake = FakeProvider()
    monkeypatch.setitem(providers.PROVIDERS, "webhook", fake)
    _, c = await make_check(org)
    await feed(c, ["down", "down", "down"])
    ds = await deliveries(org.id)
    assert [d.event for d in ds] == ["triggered"] and ds[0].status == "pending"
    assert dispatch.pending_deliveries == [ds[0].id]  # kicked after commit
    assert await send_all(now=datetime.now(UTC)) == ["sent"]
    assert fake.sent[0].subject.startswith("[TRIGGERED] [CRITICAL] INC-1")
    await feed(c, ["up"], start=T0 + timedelta(minutes=5))
    ds = await deliveries(org.id)
    assert [d.event for d in ds] == ["triggered", "resolved"]
    await send_all(now=datetime.now(UTC))
    assert "RESOLVED" in fake.sent[-1].subject


async def test_failed_delivery_retries_with_backoff_then_succeeds(monkeypatch):
    org = await make_org()
    await make_policy(org)
    fake = FakeProvider(fail_times=2)
    monkeypatch.setitem(providers.PROVIDERS, "webhook", fake)
    _, c = await make_check(org, failure_threshold=1)
    await feed(c, ["down"])
    now = datetime.now(UTC)
    assert await send_all(now) == ["pending"]
    d = (await deliveries(org.id))[0]
    assert d.attempts == 1 and d.next_attempt_at - now == sender.backoff(1) and "simulated" in d.last_error
    assert await send_all(now) == []  # not due yet
    assert await send_all(now + timedelta(seconds=31)) == ["pending"]
    assert await send_all(now + timedelta(minutes=5)) == ["sent"]
    assert len(fake.sent) == 1


async def test_permanent_failure_and_max_attempts(monkeypatch):
    org = await make_org()
    await make_policy(org)
    monkeypatch.setitem(providers.PROVIDERS, "webhook", FakeProvider(fail_times=1, retryable=False))
    _, c = await make_check(org, failure_threshold=1)
    await feed(c, ["down"])
    assert await send_all(datetime.now(UTC)) == ["failed"]
    assert (await deliveries(org.id))[0].status_reason == "permanent error"


async def test_planning_is_idempotent():
    from app.core import events
    from app.models import Incident
    from app.models.enums import NotificationEvent
    from app.notifications.planner import plan_notifications

    org = await make_org()
    await make_policy(org)
    _, c = await make_check(org, failure_threshold=1)
    await feed(c, ["down"])
    async with get_sessionmaker()() as db:
        inc = await db.scalar(select(Incident).where(Incident.organization_id == org.id))
        again = await plan_notifications(db, inc, NotificationEvent.TRIGGERED)
        await events.commit(db)
    assert again == [] and len(await deliveries(org.id)) == 1


async def test_maintenance_window_suppresses_notifications_but_keeps_incident_and_data(store):
    org = await make_org()
    await make_policy(org)
    r, c = await make_check(org, failure_threshold=1)
    async with get_sessionmaker()() as s:
        s.add(MaintenanceWindow(organization_id=org.id, name="patching", starts_at=T0 - timedelta(hours=1),
                                ends_at=T0 + timedelta(hours=1), scope="resources", resource_ids=[r.id]))
        await s.commit()
    await feed(c, ["down", "down"])
    inc = (await incidents(org.id))[0]
    assert inc.in_maintenance is True
    ds = await deliveries(org.id)
    assert ds[0].status == "suppressed" and ds[0].status_reason == "maintenance window"
    rows = store.tables["check_results"]
    assert len(rows) == 2 and all(x["in_maintenance"] == 1 and x["status"] == "down" for x in rows)


async def test_maintenance_can_suppress_incident_creation():
    org = await make_org()
    r, c = await make_check(org, failure_threshold=1)
    async with get_sessionmaker()() as s:
        s.add(MaintenanceWindow(organization_id=org.id, name="upgrade", starts_at=T0 - timedelta(hours=1),
                                ends_at=T0 + timedelta(hours=1), scope="organization", suppress_incidents=True))
        await s.commit()
    await feed(c, ["down", "down"])
    assert await incidents(org.id) == []
    async with get_sessionmaker()() as s:
        from app.models import Resource

        assert (await s.get(Resource, r.id)).status == "maintenance"


def test_quiet_hours():
    q = {"enabled": True, "start": "22:00", "end": "07:00", "timezone": "UTC", "allow_critical": True}
    night = datetime(2026, 1, 1, 23, 30, tzinfo=UTC)
    day = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    assert in_quiet_hours(q, night, "warning") and not in_quiet_hours(q, day, "warning")
    assert not in_quiet_hours(q, night, "critical")
    assert not in_quiet_hours({**q, "enabled": False}, night, "warning")


async def test_channel_rate_limit():
    org = await make_org()
    await make_policy(org, rate_limit=2)
    for i in range(4):
        _, c = await make_check(org, failure_threshold=1)
        await feed(c, ["down"])
    statuses = [d.status for d in await deliveries(org.id)]
    assert statuses.count("pending") == 2 and statuses.count("suppressed") == 2


async def test_escalation_policy_steps(monkeypatch):
    from app.core import events
    from app.notifications.planner import escalate_due

    org = await make_org()
    p, chans = await make_policy(org, channel_types=["webhook", "email"])
    async with get_sessionmaker()() as s:
        from app.models import NotificationPolicy

        pol = await s.get(NotificationPolicy, p.id)
        pol.steps = [{"delay_minutes": 0, "channel_ids": [str(chans[0].id)]},
                     {"delay_minutes": 15, "channel_ids": [str(chans[1].id)]}]
        await s.commit()
    _, c = await make_check(org, failure_threshold=1)
    await feed(c, ["down"])
    inc = (await incidents(org.id))[0]
    assert inc.next_escalation_at is not None
    async with get_sessionmaker()() as db:
        assert await escalate_due(db, now=inc.next_escalation_at - timedelta(seconds=1)) == 0
        assert await escalate_due(db, now=inc.next_escalation_at + timedelta(seconds=1)) == 1
        await events.commit(db)
    ds = await deliveries(org.id)
    assert [(d.event, d.channel_type) for d in ds] == [("triggered", "webhook"), ("escalated", "email")]


async def test_in_app_channel_creates_inbox_items(client):
    a = await make_actor(client)
    await make_policy(a.org, channel_types=["in_app"])
    _, c = await make_check(a.org, failure_threshold=1)
    await feed(c, ["down"])
    inbox = (await client.get("/api/v1/notifications/inbox", headers=a.headers)).json()
    assert inbox["unread"] == 1 and "INC-1" in inbox["items"][0]["title"]
    await client.post("/api/v1/notifications/inbox/read", headers=a.headers, json={})
    assert (await client.get("/api/v1/notifications/inbox", headers=a.headers)).json()["unread"] == 0


async def test_channel_secrets_are_write_only(client):
    a = await make_actor(client)
    r = await client.post("/api/v1/notifications/channels", headers=a.headers, json={
        "name": "tg", "type": "telegram", "config": {"chat_id": "42"}, "secrets": {"bot_token": "999:SUPERSECRETTOKEN"}})
    assert r.status_code == 201
    body = r.text
    assert "SUPERSECRETTOKEN" not in body and r.json()["secrets_configured"] == ["bot_token"]
    lst = await client.get("/api/v1/notifications/channels", headers=a.headers)
    assert "SUPERSECRETTOKEN" not in lst.text
    audit = await client.get("/api/v1/audit-logs", headers=a.headers)
    assert "SUPERSECRETTOKEN" not in audit.text


@pytest.fixture
async def webhook_receiver():
    received = []

    async def hook(request):
        received.append((dict(request.headers), await request.read()))
        return web.Response(status=204)

    app = web.Application()
    app.router.add_post("/hook", hook)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    yield f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/hook", received
    await runner.cleanup()


async def test_webhook_provider_signs_payload(webhook_receiver):
    import ipaddress

    from app.monitoring.netguard import Scope

    url, received = webhook_receiver
    scope = Scope(cidrs=(ipaddress.ip_network("127.0.0.0/8"),))
    msg = providers.OutgoingMessage(subject="s", body="b", event="triggered", incident={"number": 1})
    await providers.WebhookProvider().send({"url": url}, {"signing_secret": "k"}, msg, scope)
    headers, body = received[0]
    assert json.loads(body)["incident"]["number"] == 1
    assert headers["X-EMonitor-Signature"] == sign_payload("k", headers["X-EMonitor-Timestamp"], body)
    with pytest.raises(DeliveryError) as e:
        await providers.WebhookProvider().send({"url": url}, {}, msg, Scope(allow_public=True))
    assert e.value.retryable is False


async def test_telegram_provider_error_handling(monkeypatch):
    class Resp:
        def __init__(self, status, data):
            self.status, self._data = status, data

        async def json(self, content_type=None):
            return self._data

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class Session:
        calls: list = []

        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def post(self, url, json=None):
            Session.calls.append((url, json))
            return Resp(*Session.responses.pop(0))

    Session.responses = [(200, {"ok": True, "result": {"message_id": 5}}), (400, {"ok": False, "description": "chat not found"}),
                         (502, {})]
    monkeypatch.setattr(providers.aiohttp, "ClientSession", Session)
    msg = providers.OutgoingMessage(subject="s", body="b", event="triggered")
    tp = providers.TelegramProvider()
    assert await tp.send({"chat_id": "1"}, {"bot_token": "123:abcdefghij"}, msg, None) == "message_id=5"
    with pytest.raises(DeliveryError) as e:
        await tp.send({"chat_id": "1"}, {"bot_token": "123:abcdefghij"}, msg, None)
    assert not e.value.retryable
    with pytest.raises(DeliveryError) as e:
        await tp.send({"chat_id": "1"}, {"bot_token": "123:abcdefghij"}, msg, None)
    assert e.value.retryable


async def test_email_provider_uses_smtp(monkeypatch):
    sent = []

    class SMTP:
        def __init__(self, host, port, timeout=None):
            self.host = host

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def ehlo(self):
            pass

        def starttls(self, context=None):
            pass

        def login(self, u, p):
            pass

        def send_message(self, m):
            sent.append(m)

    import smtplib

    monkeypatch.setattr(smtplib, "SMTP", SMTP)
    monkeypatch.setattr(providers, "get_settings", lambda: type("S", (), {
        "smtp_host": "smtp.example.com", "smtp_port": 587, "smtp_username": None, "smtp_password": None,
        "smtp_starttls": True, "smtp_from": "noreply@example.com"})())
    msg = providers.OutgoingMessage(subject="Alert", body="Body", event="triggered")
    await providers.EmailProvider().send({"to": ["a@example.com"]}, {}, msg, None)
    assert sent[0]["Subject"] == "Alert" and sent[0]["To"] == "a@example.com"

