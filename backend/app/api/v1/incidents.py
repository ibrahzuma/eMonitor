from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Permission
from app.incidents import engine
from app.models import Incident, IncidentEvent, Membership, NotificationDelivery, Resource, User
from app.models.enums import OPEN_INCIDENT_STATUSES, IncidentSource, IncidentStatus, Severity
from app.schemas.common import ORM, Page, PageParams
from app.services import audit

router = APIRouter(prefix="/incidents", tags=["incidents"])


class IncidentOut(ORM):
    id: uuid.UUID
    number: int
    title: str
    description: str
    severity: str
    status: str
    source: str
    source_id: str
    dedup_key: str
    resource_id: uuid.UUID | None
    team_id: uuid.UUID | None
    assignee_id: uuid.UUID | None
    alert_rule_id: uuid.UUID | None
    trigger_condition: str
    evidence: dict[str, Any]
    first_detected_at: datetime
    last_detected_at: datetime
    acknowledged_at: datetime | None
    acknowledged_by_id: uuid.UUID | None
    resolved_at: datetime | None
    resolved_by_id: uuid.UUID | None
    resolution: str
    occurrence_count: int
    reopen_count: int
    in_maintenance: bool
    escalation_step: int
    created_at: datetime
    group_key: str
    duration_seconds: float = 0
    resource_name: str | None = None
    resource_kind: str | None = None
    assignee_name: str | None = None


class EventOut(ORM):
    id: uuid.UUID
    kind: str
    actor_user_id: uuid.UUID | None
    message: str
    data: dict[str, Any]
    created_at: datetime
    actor_name: str | None = None


class DeliveryBrief(ORM):
    id: uuid.UUID
    channel_type: str
    event: str
    status: str
    status_reason: str
    attempts: int
    last_error: str
    created_at: datetime
    sent_at: datetime | None


class IncidentDetail(IncidentOut):
    timeline: list[EventOut]
    deliveries: list[DeliveryBrief]
    related: list[IncidentOut]


async def _decorate(db: AsyncSession, items: list[Incident]) -> list[IncidentOut]:
    rids = {i.resource_id for i in items if i.resource_id}
    uids = {i.assignee_id for i in items if i.assignee_id}
    rmap = {r.id: r for r in (await db.scalars(select(Resource).where(Resource.id.in_(rids)))).all()} if rids else {}
    umap = {u.id: u for u in (await db.scalars(select(User).where(User.id.in_(uids)))).all()} if uids else {}
    now = datetime.now(UTC)
    out = []
    for i in items:
        o = IncidentOut.model_validate(i)
        o.duration_seconds = ((i.resolved_at or now) - i.first_detected_at).total_seconds()
        if i.resource_id and i.resource_id in rmap:
            o.resource_name, o.resource_kind = rmap[i.resource_id].name, rmap[i.resource_id].kind
        if i.assignee_id and i.assignee_id in umap:
            o.assignee_name = umap[i.assignee_id].full_name or umap[i.assignee_id].email
        out.append(o)
    return out


def _filters(ctx: Ctx, status: list[str] | None, severity: list[str] | None, resource_id: uuid.UUID | None,
             assignee_id: uuid.UUID | None, team_id: uuid.UUID | None, source: list[str] | None, q: str | None,
             open_only: bool, start: datetime | None, end: datetime | None):
    stmt = select(Incident).where(Incident.organization_id == ctx.org_id)
    if open_only:
        stmt = stmt.where(Incident.status.in_([s.value for s in OPEN_INCIDENT_STATUSES]))
    if status:
        stmt = stmt.where(Incident.status.in_(status))
    if severity:
        stmt = stmt.where(Incident.severity.in_(severity))
    if resource_id:
        stmt = stmt.where(Incident.resource_id == resource_id)
    if assignee_id:
        stmt = stmt.where(Incident.assignee_id == assignee_id)
    if team_id:
        stmt = stmt.where(Incident.team_id == team_id)
    if source:
        stmt = stmt.where(Incident.source.in_(source))
    if start:
        stmt = stmt.where(Incident.first_detected_at >= start)
    if end:
        stmt = stmt.where(Incident.first_detected_at < end)
    if q:
        like = f"%{q.lower()}%"
        cond = [func.lower(Incident.title).like(like), func.lower(Incident.trigger_condition).like(like)]
        digits = q.upper().removeprefix("INC-")
        if digits.isdigit():
            cond.append(Incident.number == int(digits))
        stmt = stmt.where(or_(*cond))
    return stmt


@router.get("", response_model=Page[IncidentOut])
async def list_incidents(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                         p: PageParams = Depends(), status: list[str] | None = Query(default=None),
                         severity: list[str] | None = Query(default=None), resource_id: uuid.UUID | None = None,
                         assignee_id: uuid.UUID | None = None, team_id: uuid.UUID | None = None,
                         source: list[str] | None = Query(default=None), q: str | None = Query(default=None, max_length=200),
                         open: bool = False, start: datetime | None = None, end: datetime | None = None,
                         sort: str = "-created"):
    stmt = _filters(ctx, status, severity, resource_id, assignee_id, team_id, source, q, open, start, end)
    order = {"-created": Incident.created_at.desc(), "created": Incident.created_at,
             "-last_detected": Incident.last_detected_at.desc(), "severity": Incident.severity,
             "-number": Incident.number.desc()}.get(sort, Incident.created_at.desc())
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.scalars(stmt.order_by(order).offset(p.offset).limit(p.page_size))).all()
    return Page(items=await _decorate(db, list(rows)), total=total or 0, page=p.page, page_size=p.page_size)


@router.get("/export")
async def export_incidents(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                           status: list[str] | None = Query(default=None), severity: list[str] | None = Query(default=None),
                           start: datetime | None = None, end: datetime | None = None, q: str | None = None):
    stmt = _filters(ctx, status, severity, None, None, None, None, q, False, start, end)
    rows = await _decorate(db, list((await db.scalars(stmt.order_by(Incident.number).limit(50000))).all()))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["number", "title", "severity", "status", "source", "resource", "first_detected_at", "acknowledged_at",
                "resolved_at", "duration_seconds", "occurrences", "reopen_count", "assignee", "resolution"])
    for r in rows:
        w.writerow([f"INC-{r.number}", _safe(r.title), r.severity, r.status, r.source, _safe(r.resource_name or ""),
                    r.first_detected_at.isoformat(), r.acknowledged_at.isoformat() if r.acknowledged_at else "",
                    r.resolved_at.isoformat() if r.resolved_at else "", int(r.duration_seconds), r.occurrence_count,
                    r.reopen_count, _safe(r.assignee_name or ""), _safe(r.resolution)])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=incidents.csv"})


def _safe(v: str) -> str:
    return "'" + v if v[:1] in ("=", "+", "-", "@") else v


async def _get(db: AsyncSession, ctx: Ctx, incident_id: uuid.UUID, lock: bool = False) -> Incident:
    stmt = select(Incident).where(Incident.id == incident_id, Incident.organization_id == ctx.org_id)
    if lock:
        stmt = stmt.with_for_update()
    inc = await db.scalar(stmt)
    if not inc:
        raise NotFound("Incident")
    return inc


async def _detail(db: AsyncSession, inc: Incident) -> IncidentDetail:
    base = (await _decorate(db, [inc]))[0]
    evs = (await db.scalars(select(IncidentEvent).where(IncidentEvent.incident_id == inc.id)
                            .order_by(IncidentEvent.created_at))).all()
    uids = {e.actor_user_id for e in evs if e.actor_user_id}
    names = {u.id: (u.full_name or u.email) for u in (await db.scalars(select(User).where(User.id.in_(uids)))).all()} \
        if uids else {}
    timeline = []
    for e in evs:
        eo = EventOut.model_validate(e)
        eo.actor_name = names.get(e.actor_user_id) if e.actor_user_id else None
        timeline.append(eo)
    deliveries = (await db.scalars(select(NotificationDelivery).where(NotificationDelivery.incident_id == inc.id)
                                   .order_by(NotificationDelivery.created_at))).all()
    related_rows = (await db.scalars(select(Incident).where(
        Incident.organization_id == inc.organization_id, Incident.group_key == inc.group_key, Incident.id != inc.id,
    ).order_by(Incident.created_at.desc()).limit(20))).all() if inc.group_key else []
    return IncidentDetail(**base.model_dump(), timeline=timeline,
                          deliveries=[DeliveryBrief.model_validate(d) for d in deliveries],
                          related=await _decorate(db, list(related_rows)))


@router.get("/{incident_id}", response_model=IncidentDetail)
async def get_incident(incident_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                       db: AsyncSession = Depends(get_db)):
    return await _detail(db, await _get(db, ctx, incident_id))


class ManualIncidentIn(BaseModel):
    title: str = Field(min_length=3, max_length=300)
    description: str = Field(default="", max_length=10000)
    severity: Severity = Severity.WARNING
    resource_id: uuid.UUID | None = None
    assignee_id: uuid.UUID | None = None


async def _validate_assignee(db: AsyncSession, ctx: Ctx, user_id: uuid.UUID | None) -> None:
    if user_id and not await db.scalar(select(Membership.id).where(Membership.organization_id == ctx.org_id,
                                                                   Membership.user_id == user_id)):
        raise ValidationFailed("assignee is not a member of this organization")


@router.post("", response_model=IncidentDetail, status_code=201)
async def create_incident(body: ManualIncidentIn, ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)),
                          db: AsyncSession = Depends(get_db)):
    resource = None
    if body.resource_id:
        resource = await db.scalar(select(Resource).where(Resource.id == body.resource_id,
                                                          Resource.organization_id == ctx.org_id))
        if not resource:
            raise ValidationFailed("resource not found")
    await _validate_assignee(db, ctx, body.assignee_id)
    res = await engine.raise_condition(
        db, org=ctx.org, dedup_key=f"manual:{uuid.uuid4()}", title=body.title, severity=body.severity,
        source=IncidentSource.MANUAL, resource=resource, description=body.description,
        trigger_condition="Created manually", auto_resolve=False)
    inc = res.incident
    assert inc is not None
    inc.created_by_id = ctx.user_id
    if body.assignee_id:
        inc.assignee_id = body.assignee_id
    audit.record(db, action="incident.created", ctx=ctx, target_type="incident", target_id=inc.id,
                 details={"title": body.title})
    await events.commit(db)
    return await _detail(db, inc)


class ActionIn(BaseModel):
    note: str = Field(default="", max_length=10000)


class AssignIn(BaseModel):
    assignee_id: uuid.UUID | None


class ResolveIn(BaseModel):
    resolution: str = Field(min_length=1, max_length=10000)


class UpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=3, max_length=300)
    description: str | None = Field(default=None, max_length=10000)
    severity: Severity | None = None


@router.patch("/{incident_id}", response_model=IncidentDetail)
async def update_incident(incident_id: uuid.UUID, body: UpdateIn, ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)),
                          db: AsyncSession = Depends(get_db)):
    inc = await _get(db, ctx, incident_id, lock=True)
    data = body.model_dump(exclude_unset=True, exclude_none=True)
    for k, v in data.items():
        setattr(inc, k, v)
    if data:
        engine.add_event(db, inc, "updated", ", ".join(f"{k} updated" for k in data), actor_id=ctx.user_id, data=data)
    await events.commit(db)
    return await _detail(db, inc)


@router.post("/{incident_id}/acknowledge", response_model=IncidentDetail)
async def acknowledge(incident_id: uuid.UUID, body: ActionIn | None = None,
                      ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)), db: AsyncSession = Depends(get_db)):
    inc = await _get(db, ctx, incident_id, lock=True)
    if not await engine.acknowledge(db, inc, ctx.user_id, (body.note if body else "")):
        raise ValidationFailed(f"incident in status {inc.status} cannot be acknowledged")
    await events.commit(db)
    return await _detail(db, inc)


@router.post("/{incident_id}/investigate", response_model=IncidentDetail)
async def investigate(incident_id: uuid.UUID, body: ActionIn | None = None,
                      ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)), db: AsyncSession = Depends(get_db)):
    inc = await _get(db, ctx, incident_id, lock=True)
    if not await engine.set_investigating(db, inc, ctx.user_id, (body.note if body else "")):
        raise ValidationFailed("resolved incidents cannot move to investigating")
    await events.commit(db)
    return await _detail(db, inc)


@router.post("/{incident_id}/assign", response_model=IncidentDetail)
async def assign(incident_id: uuid.UUID, body: AssignIn, ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)),
                 db: AsyncSession = Depends(get_db)):
    inc = await _get(db, ctx, incident_id, lock=True)
    await _validate_assignee(db, ctx, body.assignee_id)
    prev = inc.assignee_id
    inc.assignee_id = body.assignee_id
    name = None
    if body.assignee_id:
        u = await db.get(User, body.assignee_id)
        name = u.full_name or u.email if u else None
    engine.add_event(db, inc, "assigned", f"Assigned to {name}" if name else "Unassigned", actor_id=ctx.user_id,
                     data={"from": str(prev) if prev else None, "to": str(body.assignee_id) if body.assignee_id else None})
    events.emit(db, ctx.org_id, "incident", {**engine.incident_payload(inc), "change": "assigned"})
    await events.commit(db)
    return await _detail(db, inc)


@router.post("/{incident_id}/comments", response_model=IncidentDetail, status_code=201)
async def comment(incident_id: uuid.UUID, body: ActionIn, ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)),
                  db: AsyncSession = Depends(get_db)):
    if not body.note.strip():
        raise ValidationFailed("comment cannot be empty")
    inc = await _get(db, ctx, incident_id)
    engine.add_event(db, inc, "comment", body.note, actor_id=ctx.user_id)
    events.emit(db, ctx.org_id, "incident", {**engine.incident_payload(inc), "change": "comment"})
    await events.commit(db)
    return await _detail(db, inc)


@router.post("/{incident_id}/resolve", response_model=IncidentDetail)
async def resolve(incident_id: uuid.UUID, body: ResolveIn, ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)),
                  db: AsyncSession = Depends(get_db)):
    inc = await _get(db, ctx, incident_id, lock=True)
    if inc.status == IncidentStatus.RESOLVED:
        raise ValidationFailed("incident is already resolved")
    await engine.resolve(db, inc, resolution=body.resolution, actor_id=ctx.user_id)
    audit.record(db, action="incident.resolved", ctx=ctx, target_type="incident", target_id=inc.id)
    await events.commit(db)
    return await _detail(db, inc)


@router.post("/{incident_id}/reopen", response_model=IncidentDetail)
async def reopen(incident_id: uuid.UUID, body: ActionIn | None = None,
                 ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE)), db: AsyncSession = Depends(get_db)):
    inc = await _get(db, ctx, incident_id, lock=True)
    if not await engine.manual_reopen(db, inc, ctx.user_id, body.note if body else ""):
        raise ValidationFailed("incident cannot be reopened (not resolved, or a newer incident tracks the condition)")
    await events.commit(db)
    return await _detail(db, inc)


class BulkIn(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    action: str = Field(pattern="^(acknowledge|resolve)$")
    note: str = Field(default="", max_length=10000)


@router.post("/bulk")
async def bulk(body: BulkIn, ctx: Ctx = Depends(require(Permission.INCIDENTS_OPERATE, Permission.INCIDENTS_BULK)),
               db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(Incident).where(Incident.organization_id == ctx.org_id, Incident.id.in_(body.ids))
                             .with_for_update())).all()
    changed = 0
    for inc in rows:
        if body.action == "acknowledge":
            changed += int(await engine.acknowledge(db, inc, ctx.user_id, body.note or "Bulk acknowledged"))
        elif inc.status != IncidentStatus.RESOLVED:
            await engine.resolve(db, inc, resolution=body.note or "Bulk resolved", actor_id=ctx.user_id)
            changed += 1
    audit.record(db, action=f"incident.bulk_{body.action}", ctx=ctx, target_type="incident",
                 details={"count": changed, "requested": len(body.ids)})
    await events.commit(db)
    return {"updated": changed, "not_found": len(body.ids) - len(rows)}
