from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.core import events
from app.core.db import get_sessionmaker
from app.models import Check, Incident, NotificationChannel, NotificationPolicy, Organization, Resource
from app.models.enums import CheckOutcomeStatus
from app.monitoring.evaluator import process_check_result
from app.monitoring.probes.base import ProbeResult

T0 = datetime(2026, 1, 5, 12, 0, tzinfo=UTC)


async def make_check(org: Organization, *, kind: str = "website", check_type: str = "http", interval: int = 60,
                     failure_threshold: int = 2, severity: str = "critical", config: dict | None = None,
                     name: str | None = None) -> tuple[Resource, Check]:
    async with get_sessionmaker()() as s:
        r = Resource(organization_id=org.id, kind=kind, name=name or f"res-{uuid.uuid4().hex[:6]}",
                     address="https://example.com")
        s.add(r)
        await s.flush()
        c = Check(organization_id=org.id, resource_id=r.id, name="HTTP", type=check_type,
                  config=config or {"url": "https://example.com/"}, interval_seconds=interval, timeout_seconds=5,
                  failure_threshold=failure_threshold, recovery_threshold=1, severity=severity, next_run_at=T0,
                  created_at=T0 - timedelta(days=1))
        s.add(c)
        await s.commit()
        return r, c


async def feed(check: Check, outcomes: list[str], start: datetime = T0, step: int | None = None,
               message: str = "x", details: dict | None = None) -> list[dict]:
    """Apply a sequence of probe outcomes at consecutive slots, each in its own transaction."""
    out = []
    step = step or check.interval_seconds
    for i, o in enumerate(outcomes):
        slot = start + timedelta(seconds=step * i)
        async with get_sessionmaker()() as db:
            res = ProbeResult(CheckOutcomeStatus(o), f"{message} {o}", latency_ms=100.0 if o != "down" else None,
                              details=details or {})
            out.append(await process_check_result(db, check.id, slot, res, now=slot + timedelta(seconds=1)))
            await events.commit(db)
    return out


async def incidents(org_id: uuid.UUID) -> list[Incident]:
    async with get_sessionmaker()() as s:
        return list((await s.scalars(select(Incident).where(Incident.organization_id == org_id)
                                     .order_by(Incident.created_at))).all())


async def count(model, *where) -> int:
    async with get_sessionmaker()() as s:
        return int(await s.scalar(select(func.count()).select_from(model).where(*where)) or 0)


async def make_policy(org: Organization, channel_types: list[str] = ("webhook",), **policy_kw) -> tuple[NotificationPolicy, list[NotificationChannel]]:
    from app.core.security import encrypt_json

    async with get_sessionmaker()() as s:
        chans = []
        for t in channel_types:
            cfg = {"webhook": {"url": "https://hooks.example.com/x", "method": "POST", "headers": {}, "timeout_seconds": 5},
                   "email": {"to": ["ops@example.com"]}, "telegram": {"chat_id": "123"}, "in_app": {}}[t]
            secret = encrypt_json({"bot_token": "123456:ABCDEFGHIJK"}) if t == "telegram" else None
            ch = NotificationChannel(organization_id=org.id, name=f"{t}-ch", type=t, config=cfg, secret_enc=secret,
                                     rate_limit_per_hour=policy_kw.pop("rate_limit", 60) if t == channel_types[0] else 60)
            s.add(ch)
            chans.append(ch)
        await s.flush()
        steps = policy_kw.pop("steps", None) or [{"delay_minutes": 0, "channel_ids": [str(c.id) for c in chans]}]
        p = NotificationPolicy(organization_id=org.id, name="Default", is_default=True, steps=steps, **policy_kw)
        s.add(p)
        await s.commit()
        return p, chans
