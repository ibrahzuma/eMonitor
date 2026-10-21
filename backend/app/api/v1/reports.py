from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Permission
from app.models import Check, NotificationPolicy, Resource, Slo
from app.schemas.common import ORM, Message, resolve_range
from app.services import audit
from app.services import reports as rpt
from app.services.availability import compute_slo

router = APIRouter(tags=["reports"])

REPORTS = ("availability", "website-uptime", "service-availability", "incidents", "alerts", "utilization", "capacity",
           "ssl", "log-errors", "sla")


def _render(rep: rpt.Report, fmt: str, org_name: str, name: str):
    if fmt == "csv":
        return Response(rpt.to_csv(rep), media_type="text/csv",
                        headers={"Content-Disposition": f"attachment; filename={name}.csv"})
    if fmt == "pdf":
        return Response(rpt.to_pdf(rep, org_name), media_type="application/pdf",
                        headers={"Content-Disposition": f"attachment; filename={name}.pdf"})
    return rep.as_dict()


@router.get("/reports/{name}")
async def get_report(name: str, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                     range: str | None = "7d", start: datetime | None = None, end: datetime | None = None,
                     kind: list[str] | None = Query(default=None), environment: str | None = None,
                     team_id: uuid.UUID | None = None, group_id: uuid.UUID | None = None,
                     resource_id: list[uuid.UUID] | None = Query(default=None),
                     format: str = Query("json", pattern="^(json|csv|pdf)$")):
    if name not in REPORTS:
        raise NotFound("Report")
    s, e = resolve_range(range, start, end, default="7d")
    f = rpt.Filters(kinds=kind or [], environment=environment, team_id=team_id, group_id=group_id,
                    resource_ids=resource_id or [])
    org = ctx.org_id
    if name == "availability":
        rep = await rpt.availability_report(db, org, s, e, f)
    elif name == "website-uptime":
        rep = await rpt.availability_report(db, org, s, e, f, "Website uptime", ["website", "api"])
    elif name == "service-availability":
        rep = await rpt.availability_report(db, org, s, e, f, "Service availability",
                                            ["service", "database", "application", "network_device"])
    elif name == "incidents":
        rep = await rpt.incident_report(db, org, s, e, f)
    elif name == "alerts":
        rep = await rpt.alert_volume_report(db, org, s, e)
    elif name == "utilization":
        rep = await rpt.utilization_report(db, org, s, e, f)
    elif name == "capacity":
        rep = await rpt.capacity_report(db, org, s, e, f)
    elif name == "ssl":
        rep = await rpt.ssl_report(db, org)
    elif name == "log-errors":
        rep = await rpt.log_error_report(db, org, s, e)
    else:
        rep = await rpt.sla_report(db, org)
    return _render(rep, format, ctx.org.name, name)


# ---------------------------------------------------------------- SLOs

class SloIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    resource_id: uuid.UUID
    check_id: uuid.UUID | None = None
    target_percent: float = Field(default=99.9, gt=0, lt=100)
    window_days: int = Field(default=30, ge=1, le=365)
    burn_rate_alerts: bool = True
    fast_burn_threshold: float = Field(default=14.4, gt=0, le=1000)
    slow_burn_threshold: float = Field(default=6.0, gt=0, le=1000)
    notification_policy_id: uuid.UUID | None = None


class SloOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    resource_id: uuid.UUID
    check_id: uuid.UUID | None
    target_percent: float
    window_days: int
    burn_rate_alerts: bool
    fast_burn_threshold: float
    slow_burn_threshold: float
    notification_policy_id: uuid.UUID | None
    last_evaluated_at: datetime | None
    last_status: dict[str, Any]
    created_at: datetime
    resource_name: str | None = None


async def _validate_slo(db: AsyncSession, ctx: Ctx, body: SloIn) -> None:
    if not await db.scalar(select(Resource.id).where(Resource.id == body.resource_id,
                                                     Resource.organization_id == ctx.org_id)):
        raise ValidationFailed("resource not found")
    if body.check_id and not await db.scalar(select(Check.id).where(Check.id == body.check_id,
                                                                    Check.resource_id == body.resource_id)):
        raise ValidationFailed("check does not belong to the resource")
    if body.notification_policy_id and not await db.scalar(select(NotificationPolicy.id).where(
            NotificationPolicy.id == body.notification_policy_id, NotificationPolicy.organization_id == ctx.org_id)):
        raise ValidationFailed("notification policy not found")


@router.get("/slos", response_model=list[SloOut])
async def list_slos(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                    live: bool = False):
    rows = (await db.execute(select(Slo, Resource.name).join(Resource, Resource.id == Slo.resource_id)
                             .where(Slo.organization_id == ctx.org_id).order_by(Slo.name))).all()
    out = []
    for slo, rname in rows:
        o = SloOut.model_validate(slo)
        o.resource_name = rname
        if live:
            o.last_status = (await compute_slo(db, slo)).as_dict()
        out.append(o)
    return out


@router.post("/slos", response_model=SloOut, status_code=201)
async def create_slo(body: SloIn, ctx: Ctx = Depends(require(Permission.SLO_MANAGE)), db: AsyncSession = Depends(get_db)):
    await _validate_slo(db, ctx, body)
    slo = Slo(organization_id=ctx.org_id, **body.model_dump())
    db.add(slo)
    await db.flush()
    slo.last_status = (await compute_slo(db, slo)).as_dict()
    audit.record(db, action="slo.created", ctx=ctx, target_type="slo", target_id=slo.id, details={"name": slo.name})
    await db.commit()
    return SloOut.model_validate(slo)


@router.get("/slos/{slo_id}", response_model=SloOut)
async def get_slo(slo_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    slo = await db.scalar(select(Slo).where(Slo.id == slo_id, Slo.organization_id == ctx.org_id))
    if not slo:
        raise NotFound("SLO")
    o = SloOut.model_validate(slo)
    o.last_status = (await compute_slo(db, slo)).as_dict()
    return o


@router.put("/slos/{slo_id}", response_model=SloOut)
async def update_slo(slo_id: uuid.UUID, body: SloIn, ctx: Ctx = Depends(require(Permission.SLO_MANAGE)),
                     db: AsyncSession = Depends(get_db)):
    slo = await db.scalar(select(Slo).where(Slo.id == slo_id, Slo.organization_id == ctx.org_id))
    if not slo:
        raise NotFound("SLO")
    await _validate_slo(db, ctx, body)
    for k, v in body.model_dump().items():
        setattr(slo, k, v)
    audit.record(db, action="slo.updated", ctx=ctx, target_type="slo", target_id=slo.id)
    await db.commit()
    return SloOut.model_validate(slo)


@router.delete("/slos/{slo_id}", response_model=Message)
async def delete_slo(slo_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.SLO_MANAGE)),
                     db: AsyncSession = Depends(get_db)):
    slo = await db.scalar(select(Slo).where(Slo.id == slo_id, Slo.organization_id == ctx.org_id))
    if not slo:
        raise NotFound("SLO")
    await db.delete(slo)
    audit.record(db, action="slo.deleted", ctx=ctx, target_type="slo", target_id=slo_id)
    await db.commit()
    return Message(message="SLO deleted")
