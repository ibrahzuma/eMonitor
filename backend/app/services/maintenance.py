"""Maintenance window evaluation (one-off and recurring, time-zone aware)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from dateutil import rrule
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MaintenanceWindow, Resource

_FREQ = {"daily": rrule.DAILY, "weekly": rrule.WEEKLY, "monthly": rrule.MONTHLY}


def _rule(window: MaintenanceWindow) -> rrule.rrule | None:
    rec = window.recurrence
    if not rec or rec.get("freq") not in _FREQ:
        return None
    tz = ZoneInfo(window.timezone or "UTC")
    start_local = window.starts_at.astimezone(tz).replace(tzinfo=None)
    kwargs: dict[str, Any] = {"dtstart": start_local, "interval": max(1, int(rec.get("interval") or 1))}
    if rec.get("byweekday"):
        kwargs["byweekday"] = [int(d) for d in rec["byweekday"]]
    if rec.get("count"):
        kwargs["count"] = int(rec["count"])
    elif rec.get("until"):
        until = datetime.fromisoformat(str(rec["until"]))
        if until.tzinfo is not None:
            until = until.astimezone(tz).replace(tzinfo=None)
        kwargs["until"] = until
    return rrule.rrule(_FREQ[rec["freq"]], **kwargs)


def occurrence_at(window: MaintenanceWindow, now: datetime) -> tuple[datetime, datetime] | None:
    """Return the (start, end) in UTC of the occurrence covering `now`, if any."""
    if not window.is_active:
        return None
    duration = window.ends_at - window.starts_at
    if duration <= timedelta(0):
        return None
    rule = _rule(window)
    if rule is None:
        return (window.starts_at, window.ends_at) if window.starts_at <= now < window.ends_at else None
    tz = ZoneInfo(window.timezone or "UTC")
    now_local = now.astimezone(tz).replace(tzinfo=None)
    # Occurrences are defined in local wall-clock time so "every day 02:00" survives DST changes.
    start_local = rule.before(now_local, inc=True)
    if start_local is None:
        return None
    start = start_local.replace(tzinfo=tz).astimezone(UTC)
    end = start + duration
    return (start, end) if start <= now < end else None


def next_occurrence(window: MaintenanceWindow, after: datetime) -> tuple[datetime, datetime] | None:
    duration = window.ends_at - window.starts_at
    rule = _rule(window)
    if rule is None:
        return (window.starts_at, window.ends_at) if window.ends_at > after else None
    tz = ZoneInfo(window.timezone or "UTC")
    nxt = rule.after(after.astimezone(tz).replace(tzinfo=None), inc=True)
    if nxt is None:
        return None
    start = nxt.replace(tzinfo=tz).astimezone(UTC)
    return start, start + duration


def is_expired(window: MaintenanceWindow, now: datetime) -> bool:
    if window.recurrence:
        cur = occurrence_at(window, now)
        return cur is None and next_occurrence(window, now) is None
    return window.ends_at <= now


def covers(window: MaintenanceWindow, resource_id: uuid.UUID | None, group_id: uuid.UUID | None) -> bool:
    if window.scope == "organization":
        return True
    if window.scope == "resources":
        return resource_id is not None and resource_id in (window.resource_ids or [])
    if window.scope == "groups":
        return group_id is not None and group_id in (window.group_ids or [])
    return False


async def active_windows(db: AsyncSession, org_id: uuid.UUID, now: datetime) -> list[MaintenanceWindow]:
    rows = (await db.scalars(
        select(MaintenanceWindow).where(
            MaintenanceWindow.organization_id == org_id,
            MaintenanceWindow.is_active.is_(True),
            MaintenanceWindow.starts_at <= now,
        )
    )).all()
    return [w for w in rows if occurrence_at(w, now) is not None]


async def windows_for_resource(db: AsyncSession, resource: Resource | None, org_id: uuid.UUID,
                               now: datetime) -> list[MaintenanceWindow]:
    windows = await active_windows(db, org_id, now)
    if resource is None:
        return [w for w in windows if w.scope == "organization"]
    group_ids = await _group_ancestors(db, resource.group_id)
    return [w for w in windows if covers(w, resource.id, None) or any(covers(w, None, g) for g in group_ids)
            or w.scope == "organization"]


async def _group_ancestors(db: AsyncSession, group_id: uuid.UUID | None) -> list[uuid.UUID]:
    from app.models import ResourceGroup

    out: list[uuid.UUID] = []
    seen = set()
    while group_id and group_id not in seen and len(out) < 20:
        seen.add(group_id)
        out.append(group_id)
        group_id = await db.scalar(select(ResourceGroup.parent_id).where(ResourceGroup.id == group_id))
    return out
