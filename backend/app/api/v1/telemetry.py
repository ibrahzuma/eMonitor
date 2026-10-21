"""Metric queries, log search/ingestion and saved searches."""

from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.agents import LogsIn, build_log_rows, enforce_log_quota
from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Permission
from app.models import Resource, SavedSearch
from app.schemas.common import ORM, Message, auto_step, resolve_range
from app.telemetry.ingest import publish_rows
from app.telemetry.store import AGGREGATIONS, LogQuery, get_store

router = APIRouter(tags=["telemetry"])


async def _owned_resources(db: AsyncSession, ctx: Ctx, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    if not ids:
        return []
    found = set((await db.scalars(select(Resource.id).where(Resource.organization_id == ctx.org_id,
                                                            Resource.id.in_(ids)))).all())
    if len(found) != len(set(ids)):
        raise NotFound("Resource")
    return list(found)


# ---------------------------------------------------------------- metrics

@router.get("/metrics/series")
async def metric_series(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                        resource_id: list[uuid.UUID] = Query(..., max_length=20),
                        metric: str = Query(..., pattern=r"^[a-z][a-z0-9_]{0,63}$"), instance: str | None = None,
                        range: str | None = "1h", start: datetime | None = None, end: datetime | None = None,
                        step: int | None = Query(default=None, ge=10, le=86400), agg: str = "avg"):
    if agg not in AGGREGATIONS:
        raise ValidationFailed(f"agg must be one of {sorted(AGGREGATIONS)}")
    rids = await _owned_resources(db, ctx, resource_id)
    s, e = resolve_range(range, start, end)
    st = step or auto_step(s, e)
    points = await get_store().metric_series(ctx.org_id, rids, metric, instance, s, e, st, agg)
    series: dict[str, dict[str, Any]] = {}
    for p in points:
        key = f"{p['resource_id']}|{p['instance']}"
        series.setdefault(key, {"resource_id": str(p["resource_id"]), "instance": p["instance"], "points": []})
        series[key]["points"].append([p["ts"], p["value"]])
    return {"metric": metric, "start": s, "end": e, "step": st, "agg": agg, "series": list(series.values())}


@router.get("/metrics/latest")
async def metric_latest(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                        db: AsyncSession = Depends(get_db)):
    await _owned_resources(db, ctx, [resource_id])
    return await get_store().metric_latest(ctx.org_id, resource_id)


@router.get("/metrics/names")
async def metric_names(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                       db: AsyncSession = Depends(get_db)):
    await _owned_resources(db, ctx, [resource_id])
    return await get_store().metric_names(ctx.org_id, resource_id)


class CustomMetric(BaseModel):
    resource_id: uuid.UUID
    metric: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    instance: str = Field(default="", max_length=128)
    value: float
    ts: datetime | None = None


class CustomMetricsIn(BaseModel):
    points: list[CustomMetric] = Field(min_length=1, max_length=5000)


@router.post("/metrics/ingest", status_code=202)
async def ingest_custom_metrics(body: CustomMetricsIn, ctx: Ctx = Depends(require(Permission.METRICS_WRITE)),
                                db: AsyncSession = Depends(get_db)):
    """Integration endpoint for exporters/telemetry sources (API key with metrics:write)."""
    import math
    from datetime import UTC, timedelta

    await _owned_resources(db, ctx, list({p.resource_id for p in body.points}))
    now = datetime.now(UTC)
    rows = []
    for p in body.points:
        if not math.isfinite(p.value):
            raise ValidationFailed("metric values must be finite")
        ts = p.ts or now
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        if not (now - timedelta(days=1) <= ts <= now + timedelta(minutes=5)):
            raise ValidationFailed("timestamps must be within the last 24 hours")
        rows.append({"ts": ts, "org_id": ctx.org_id, "resource_id": p.resource_id, "metric": p.metric,
                     "instance": p.instance, "value": p.value, "source": "api"})
    await publish_rows("metrics", rows)
    return {"accepted": len(rows)}


# ---------------------------------------------------------------- logs

def _log_query(start: datetime, end: datetime, q: str | None, severity: list[str] | None, min_severity: str | None,
               resource_id: list[uuid.UUID] | None, host: list[str] | None, application: list[str] | None,
               service: list[str] | None, source: list[str] | None, environment: str | None, trace_id: str | None,
               attr: list[str] | None) -> LogQuery:
    attributes: dict[str, str] = {}
    for a in attr or []:
        if "=" not in a:
            raise ValidationFailed("attr filters must look like key=value")
        k, v = a.split("=", 1)
        attributes[k.strip()[:64]] = v[:1024]
    return LogQuery(start=start, end=end, text=(q or "")[:500], severities=severity or [], min_severity=min_severity,
                    resource_ids=resource_id or [], hosts=host or [], applications=application or [],
                    services=service or [], sources=source or [], environment=environment, trace_id=trace_id,
                    attributes=attributes)


class LogFilterParams:
    def __init__(self, q: str | None = Query(default=None, max_length=500),
                 severity: list[str] | None = Query(default=None), min_severity: str | None = None,
                 resource_id: list[uuid.UUID] | None = Query(default=None),
                 host: list[str] | None = Query(default=None), application: list[str] | None = Query(default=None),
                 service: list[str] | None = Query(default=None), source: list[str] | None = Query(default=None),
                 environment: str | None = None, trace_id: str | None = Query(default=None, max_length=128),
                 attr: list[str] | None = Query(default=None), range: str | None = "1h", start: datetime | None = None,
                 end: datetime | None = None):
        self.args = (q, severity, min_severity, resource_id, host, application, service, source, environment, trace_id,
                     attr)
        self.range, self.start, self.end = range, start, end
        self.resource_ids = resource_id or []

    def build(self, max_days: int = 90) -> LogQuery:
        s, e = resolve_range(self.range, self.start, self.end, default="1h", max_days=max_days)
        return _log_query(s, e, *self.args)


@router.get("/logs/search")
async def search_logs(ctx: Ctx = Depends(require(Permission.LOGS_READ)), db: AsyncSession = Depends(get_db),
                      f: LogFilterParams = Depends(), limit: int = Query(100, ge=1, le=1000),
                      cursor: str | None = Query(default=None, max_length=200)):
    await _owned_resources(db, ctx, f.resource_ids)
    q = f.build()
    rows, nxt = await get_store().search_logs(ctx.org_id, q, limit, cursor)
    return {"items": rows, "next_cursor": nxt, "start": q.start, "end": q.end}


@router.get("/logs/histogram")
async def logs_histogram(ctx: Ctx = Depends(require(Permission.LOGS_READ)), db: AsyncSession = Depends(get_db),
                         f: LogFilterParams = Depends(), bucket: int | None = Query(default=None, ge=1, le=86400)):
    await _owned_resources(db, ctx, f.resource_ids)
    q = f.build()
    b = bucket or auto_step(q.start, q.end, 120)
    return {"bucket_seconds": b, "points": await get_store().log_histogram(ctx.org_id, q, b)}


@router.get("/logs/facets")
async def logs_facets(field: str = Query(..., pattern="^(host|application|service|source|severity|environment)$"),
                      ctx: Ctx = Depends(require(Permission.LOGS_READ)), db: AsyncSession = Depends(get_db),
                      f: LogFilterParams = Depends()):
    await _owned_resources(db, ctx, f.resource_ids)
    return await get_store().log_facets(ctx.org_id, f.build(), field)


@router.get("/logs/export")
async def export_logs(ctx: Ctx = Depends(require(Permission.LOGS_READ)), db: AsyncSession = Depends(get_db),
                      f: LogFilterParams = Depends(), limit: int = Query(5000, ge=1, le=50000)):
    await _owned_resources(db, ctx, f.resource_ids)
    q = f.build()
    store = get_store()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["timestamp", "severity", "host", "application", "service", "source", "trace_id", "message"])
    cursor = None
    written = 0
    while written < limit:
        rows, cursor = await store.search_logs(ctx.org_id, q, min(1000, limit - written), cursor)
        for r in rows:
            w.writerow([r["ts"], r["severity"], r["host"], r["application"], r["service"], r["source"], r["trace_id"],
                        _csv_safe(r["message"])])
        written += len(rows)
        if not cursor or not rows:
            break
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=logs.csv"})


def _csv_safe(v: str) -> str:
    """Neutralize spreadsheet formula injection."""
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


@router.post("/logs/ingest", status_code=202)
async def ingest_logs(body: LogsIn, ctx: Ctx = Depends(require(Permission.LOGS_WRITE)), db: AsyncSession = Depends(get_db)):
    """HTTP log ingestion for applications and integrations (API key with logs:write)."""
    await enforce_log_quota(ctx.org, len(body.records))
    rids = {r.resource_id for r in body.records if r.resource_id}
    valid = set(await db.scalars(select(Resource.id).where(Resource.organization_id == ctx.org_id,
                                                            Resource.id.in_(rids)))) if rids else set()
    rows = build_log_rows(ctx.org, body.records, valid_resources=valid)
    await publish_rows("logs", rows)
    return {"accepted": len(rows)}


# ---------------------------------------------------------------- saved searches

class SavedSearchIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(default="logs", pattern="^(logs|resources|incidents)$")
    query: dict[str, Any] = Field(default_factory=dict)
    shared: bool = False


class SavedSearchOut(ORM):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    kind: str
    query: dict[str, Any]
    shared: bool
    created_at: datetime


@router.get("/saved-searches", response_model=list[SavedSearchOut])
async def list_saved(kind: str | None = None, ctx: Ctx = Depends(require(Permission.VIEW)),
                     db: AsyncSession = Depends(get_db)):
    stmt = select(SavedSearch).where(SavedSearch.organization_id == ctx.org_id,
                                     or_(SavedSearch.user_id == ctx.user_id, SavedSearch.shared.is_(True)))
    if kind:
        stmt = stmt.where(SavedSearch.kind == kind)
    return (await db.scalars(stmt.order_by(SavedSearch.name))).all()


@router.post("/saved-searches", response_model=SavedSearchOut, status_code=201)
async def create_saved(body: SavedSearchIn, ctx: Ctx = Depends(require(Permission.VIEW)),
                       db: AsyncSession = Depends(get_db)):
    if not ctx.user_id:
        raise ValidationFailed("saved searches belong to users")
    if len(str(body.query)) > 5000:
        raise ValidationFailed("query too large")
    s = SavedSearch(organization_id=ctx.org_id, user_id=ctx.user_id, name=body.name, kind=body.kind, query=body.query,
                    shared=body.shared)
    db.add(s)
    await db.commit()
    return s


@router.delete("/saved-searches/{search_id}", response_model=Message)
async def delete_saved(search_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                       db: AsyncSession = Depends(get_db)):
    s = await db.scalar(select(SavedSearch).where(SavedSearch.id == search_id, SavedSearch.organization_id == ctx.org_id,
                                                  SavedSearch.user_id == ctx.user_id))
    if not s:
        raise NotFound("Saved search")
    await db.delete(s)
    await db.commit()
    return Message(message="Saved search deleted")
