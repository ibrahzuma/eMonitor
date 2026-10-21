from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Permission
from app.models import MaintenanceWindow, Membership, Resource, ResourceGroup
from app.monitoring.evaluator import recompute_resource_status
from app.schemas.common import ORM, Message
from app.services import audit, maintenance

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


class Recurrence(BaseModel):
    freq: Literal["daily", "weekly", "monthly"]
    interval: int = Field(default=1, ge=1, le=52)
    byweekday: list[int] = Field(default_factory=list)  # 0=Mon … 6=Sun
    until: datetime | None = None
    count: int | None = Field(default=None, ge=1, le=1000)

    @field_validator("byweekday")
    @classmethod
    def _wd(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("weekdays must be 0 (Mon) to 6 (Sun)")
        return sorted(set(v))


class WindowIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    reason: str = Field(default="", max_length=5000)
    starts_at: datetime
    ends_at: datetime
    timezone: str = "UTC"
    recurrence: Recurrence | None = None
    scope: Literal["resources", "groups", "organization"] = "resources"
    resource_ids: list[uuid.UUID] = Field(default_factory=list, max_length=1000)
    group_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)
    suppress_notifications: bool = True
    suppress_incidents: bool = False
    responsible_user_id: uuid.UUID | None = None
    is_active: bool = True

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        ZoneInfo(v)
        return v

    @model_validator(mode="after")
    def _check(self) -> WindowIn:
        for f in ("starts_at", "ends_at"):
            v = getattr(self, f)
            if v.tzinfo is None:  # naive input is interpreted in the window's time zone
                setattr(self, f, v.replace(tzinfo=ZoneInfo(self.timezone)))
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.recurrence and self.ends_at - self.starts_at > timedelta(days=31):
            raise ValueError("recurring windows may last at most 31 days per occurrence")
        if self.scope == "resources" and not self.resource_ids:
            raise ValueError("select at least one resource")
        if self.scope == "groups" and not self.group_ids:
            raise ValueError("select at least one group")
        return self


class WindowOut(ORM):
    id: uuid.UUID
    name: str
    reason: str
    starts_at: datetime
    ends_at: datetime
    timezone: str
    recurrence: dict[str, Any] | None
    scope: str
    resource_ids: list[uuid.UUID]
    group_ids: list[uuid.UUID]
    suppress_notifications: bool
    suppress_incidents: bool
    responsible_user_id: uuid.UUID | None
    created_by_id: uuid.UUID | None
    is_active: bool
    created_at: datetime
    active_now: bool = False
    current_occurrence: dict[str, datetime] | None = None
    next_occurrence: dict[str, datetime] | None = None
    expired: bool = False


def _out(w: MaintenanceWindow, now: datetime) -> WindowOut:
    o = WindowOut.model_validate(w)
    cur = maintenance.occurrence_at(w, now)
    o.active_now = cur is not None
    o.current_occurrence = {"start": cur[0], "end": cur[1]} if cur else None
    nxt = maintenance.next_occurrence(w, now)
    o.next_occurrence = {"start": nxt[0], "end": nxt[1]} if nxt else None
    o.expired = maintenance.is_expired(w, now)
    return o


async def _validate(db: AsyncSession, ctx: Ctx, body: WindowIn) -> None:
    if body.resource_ids:
        n = set((await db.scalars(select(Resource.id).where(Resource.organization_id == ctx.org_id,
                                                            Resource.id.in_(body.resource_ids)))).all())
        if n != set(body.resource_ids):
            raise ValidationFailed("some resources were not found")
    if body.group_ids:
        n = set((await db.scalars(select(ResourceGroup.id).where(ResourceGroup.organization_id == ctx.org_id,
                                                                 ResourceGroup.id.in_(body.group_ids)))).all())
        if n != set(body.group_ids):
            raise ValidationFailed("some groups were not found")
    if body.responsible_user_id and not await db.scalar(select(Membership.id).where(
            Membership.organization_id == ctx.org_id, Membership.user_id == body.responsible_user_id)):
        raise ValidationFailed("responsible user is not a member of this organization")


async def _refresh_status(db: AsyncSession, ctx: Ctx, w: MaintenanceWindow) -> None:
    stmt = select(Resource).where(Resource.organization_id == ctx.org_id)
    if w.scope == "resources":
        stmt = stmt.where(Resource.id.in_(w.resource_ids or []))
    elif w.scope == "groups":
        stmt = stmt.where(Resource.group_id.in_(w.group_ids or []))
    for r in (await db.scalars(stmt.limit(5000))).all():
        await recompute_resource_status(db, r)


def _data(body: WindowIn) -> dict[str, Any]:
    d = body.model_dump(exclude={"recurrence"})
    d["starts_at"] = body.starts_at.astimezone(UTC)
    d["ends_at"] = body.ends_at.astimezone(UTC)
    d["recurrence"] = body.recurrence.model_dump(mode="json") if body.recurrence else None
    return d


@router.get("", response_model=list[WindowOut])
async def list_windows(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                       include_expired: bool = False):
    now = datetime.now(UTC)
    rows = (await db.scalars(select(MaintenanceWindow).where(MaintenanceWindow.organization_id == ctx.org_id)
                             .order_by(MaintenanceWindow.starts_at.desc()))).all()
    out = [_out(w, now) for w in rows]
    return out if include_expired else [o for o in out if not o.expired or o.active_now]


@router.post("", response_model=WindowOut, status_code=201)
async def create_window(body: WindowIn, ctx: Ctx = Depends(require(Permission.MAINTENANCE_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    await _validate(db, ctx, body)
    w = MaintenanceWindow(organization_id=ctx.org_id, created_by_id=ctx.user_id, **_data(body))
    if w.responsible_user_id is None:
        w.responsible_user_id = ctx.user_id
    db.add(w)
    await db.flush()
    await _refresh_status(db, ctx, w)
    audit.record(db, action="maintenance.created", ctx=ctx, target_type="maintenance_window", target_id=w.id,
                 details={"name": w.name, "scope": w.scope, "starts_at": w.starts_at.isoformat(),
                          "ends_at": w.ends_at.isoformat()})
    await events.commit(db)
    return _out(w, datetime.now(UTC))


async def _window(db: AsyncSession, ctx: Ctx, wid: uuid.UUID) -> MaintenanceWindow:
    w = await db.scalar(select(MaintenanceWindow).where(MaintenanceWindow.id == wid,
                                                        MaintenanceWindow.organization_id == ctx.org_id))
    if not w:
        raise NotFound("Maintenance window")
    return w


@router.put("/{window_id}", response_model=WindowOut)
async def update_window(window_id: uuid.UUID, body: WindowIn, ctx: Ctx = Depends(require(Permission.MAINTENANCE_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    w = await _window(db, ctx, window_id)
    await _validate(db, ctx, body)
    old_scope = (w.scope, list(w.resource_ids or []), list(w.group_ids or []))
    for k, v in _data(body).items():
        setattr(w, k, v)
    await db.flush()
    await _refresh_status(db, ctx, w)
    if old_scope != (w.scope, list(w.resource_ids or []), list(w.group_ids or [])):
        tmp = MaintenanceWindow(scope=old_scope[0], resource_ids=old_scope[1], group_ids=old_scope[2])
        await _refresh_status(db, ctx, tmp)
    audit.record(db, action="maintenance.updated", ctx=ctx, target_type="maintenance_window", target_id=w.id,
                 details={"name": w.name})
    await events.commit(db)
    return _out(w, datetime.now(UTC))


@router.post("/{window_id}/end", response_model=WindowOut)
async def end_window(window_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.MAINTENANCE_MANAGE)),
                     db: AsyncSession = Depends(get_db)):
    """End a running window early (deactivates it)."""
    w = await _window(db, ctx, window_id)
    w.is_active = False
    await db.flush()
    await _refresh_status(db, ctx, w)
    audit.record(db, action="maintenance.ended", ctx=ctx, target_type="maintenance_window", target_id=w.id)
    await events.commit(db)
    return _out(w, datetime.now(UTC))


@router.delete("/{window_id}", response_model=Message)
async def delete_window(window_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.MAINTENANCE_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    w = await _window(db, ctx, window_id)
    scope_copy = MaintenanceWindow(scope=w.scope, resource_ids=list(w.resource_ids or []),
                                   group_ids=list(w.group_ids or []))
    await db.delete(w)
    await db.flush()
    await _refresh_status(db, ctx, scope_copy)
    audit.record(db, action="maintenance.deleted", ctx=ctx, target_type="maintenance_window", target_id=window_id,
                 details={"name": w.name})
    await events.commit(db)
    return Message(message="Maintenance window deleted")
