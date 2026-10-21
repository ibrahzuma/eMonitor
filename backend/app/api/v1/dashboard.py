"""Overview dashboard aggregates. Every number comes from stored monitoring data."""

from __future__ import annotations

import builtins
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.permissions import Permission
from app.models import Check, Incident, NotificationDelivery, Resource, ServerDetail
from app.models.enums import OPEN_INCIDENT_STATUSES, ResourceKind
from app.schemas.common import auto_step, resolve_range
from app.services.availability import check_availability, combine
from app.telemetry.store import LogQuery, get_store

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _resource_filter(stmt, ctx: Ctx, environment: str | None, group_id: uuid.UUID | None):
    stmt = stmt.where(Resource.organization_id == ctx.org_id)
    if environment:
        stmt = stmt.where(Resource.environment == environment)
    if group_id:
        stmt = stmt.where(Resource.group_id == group_id)
    return stmt


@router.get("/summary")
async def summary(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                  environment: str | None = None, group_id: uuid.UUID | None = None):
    now = datetime.now(UTC)
    rows = (await db.execute(_resource_filter(select(Resource.kind, Resource.status, func.count()), ctx, environment,
                                              group_id).group_by(Resource.kind, Resource.status))).all()
    by_kind: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for kind, status, n in rows:
        by_kind[kind][status] += n

    def block(kinds: list[str]) -> dict:
        agg: dict[str, int] = defaultdict(int)
        for k in kinds:
            for st, n in by_kind.get(k, {}).items():
                agg[st] += n
        return {"total": sum(agg.values()), **{s: agg.get(s, 0) for s in
                                               ("healthy", "warning", "critical", "unreachable", "unknown", "maintenance")}}

    servers = block([ResourceKind.SERVER])
    websites = block([ResourceKind.WEBSITE, ResourceKind.API])
    devices = block([ResourceKind.NETWORK_DEVICE])
    services = block([ResourceKind.SERVICE, ResourceKind.DATABASE, ResourceKind.APPLICATION])

    web_ids = (await db.scalars(_resource_filter(select(Resource.id), ctx, environment, group_id).where(
        Resource.kind.in_([ResourceKind.WEBSITE, ResourceKind.API])))).all()
    web_checks = list((await db.scalars(select(Check).where(Check.resource_id.in_(web_ids), Check.enabled.is_(True)))).all()) \
        if web_ids else []
    websites_down = sum(1 for c in web_checks if c.last_outcome == "down")
    uptime = avg_ms = None
    if web_checks:
        try:
            av = await check_availability(ctx.org_id, web_checks, now - timedelta(hours=24), now)
            total = combine(list(av.values()))
            if total:
                uptime, avg_ms = total.uptime_percent, total.avg_ms
        except Exception:
            pass

    open_statuses = [s.value for s in OPEN_INCIDENT_STATUSES]
    open_count = await db.scalar(select(func.count()).select_from(Incident).where(
        Incident.organization_id == ctx.org_id, Incident.status.in_(open_statuses)))
    critical_open = await db.scalar(select(func.count()).select_from(Incident).where(
        Incident.organization_id == ctx.org_id, Incident.status.in_(open_statuses), Incident.severity == "critical"))
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today = await db.scalar(select(func.count()).select_from(Incident).where(
        Incident.organization_id == ctx.org_id, Incident.first_detected_at >= midnight))
    notified_today = await db.scalar(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.organization_id == ctx.org_id, NotificationDelivery.created_at >= midnight,
        NotificationDelivery.status == "sent"))

    failures = (await db.execute(
        select(Check, Resource.name, Resource.kind).join(Resource, Resource.id == Check.resource_id)
        .where(Check.organization_id == ctx.org_id, Check.enabled.is_(True), Check.last_outcome == "down")
        .order_by(Check.last_run_at.desc()).limit(10))).all()
    srv = (await db.execute(_resource_filter(select(Resource, ServerDetail).join(
        ServerDetail, ServerDetail.resource_id == Resource.id), ctx, environment, group_id)
        .order_by(Resource.name).limit(200))).all()
    return {
        "generated_at": now,
        "servers": servers, "websites": {**websites, "down": websites_down, "uptime_24h": uptime,
                                         "avg_response_ms_24h": avg_ms},
        "network_devices": devices, "services": services,
        "incidents": {"open": open_count or 0, "critical_open": critical_open or 0, "triggered_today": today or 0,
                      "notifications_sent_today": notified_today or 0},
        "recent_failures": [{"check_id": str(c.id), "check": c.name, "type": c.type, "resource": name, "kind": kind,
                             "resource_id": str(c.resource_id), "message": c.last_message, "since": c.state_changed_at,
                             "last_run_at": c.last_run_at} for c, name, kind in failures],
        "server_overview": [{"id": str(r.id), "name": r.name, "status": r.status,
                             "cpu_percent": (sd.latest or {}).get("cpu_percent"),
                             "memory_percent": (sd.latest or {}).get("memory_percent"),
                             "disk_percent_max": (sd.latest or {}).get("disk_percent_max"),
                             "load1": (sd.latest or {}).get("load1"), "last_metrics_at": sd.last_metrics_at}
                            for r, sd in srv],
    }


@router.get("/trends")
async def trends(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                 range: str | None = "7d", start: datetime | None = None, end: datetime | None = None,
                 environment: str | None = None, group_id: uuid.UUID | None = None):
    s, e = resolve_range(range, start, end, default="7d")
    bucket = 86400 if (e - s) > timedelta(days=2) else 3600
    incidents = (await db.execute(select(Incident.first_detected_at, Incident.severity).where(
        Incident.organization_id == ctx.org_id, Incident.first_detected_at >= s, Incident.first_detected_at < e))).all()
    inc_buckets: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for ts, sev in incidents:
        b = int(ts.timestamp()) // bucket * bucket
        inc_buckets[b][sev] += 1
    start_b = int(s.timestamp()) // bucket * bucket
    incident_trend = [{"ts": datetime.fromtimestamp(b, UTC), **{k: inc_buckets[b].get(k, 0)
                                                                for k in ("critical", "high", "warning", "info")}}
                      for b in builtins.range(start_b, int(e.timestamp()) + 1, bucket)]
    ids = (await db.scalars(_resource_filter(select(Resource.id), ctx, environment, group_id))).all()
    check_ids = list((await db.scalars(select(Check.id).where(Check.resource_id.in_(ids), Check.enabled.is_(True))))
                     .all()) if ids else []
    points = await get_store().check_buckets(ctx.org_id, check_ids, s, e, bucket) if check_ids else []
    availability = []
    for p in points:
        known = p["up"] + p["degraded"] + p["down"]
        availability.append({"ts": p["bucket"], "uptime_percent": round((p["up"] + p["degraded"]) / known * 100, 3)
                             if known else None, "down": p["down"], "unknown": p["unknown"], "avg_ms": p.get("avg_ms")})
    return {"bucket_seconds": bucket, "incidents": incident_trend, "availability": availability}


@router.get("/traffic")
async def traffic(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                  range: str | None = "6h", environment: str | None = None, group_id: uuid.UUID | None = None):
    s, e = resolve_range(range, None, None, default="6h")
    ids = list((await db.scalars(_resource_filter(select(Resource.id), ctx, environment, group_id).where(
        Resource.kind.in_([ResourceKind.SERVER, ResourceKind.NETWORK_DEVICE])).limit(200))).all())
    step = auto_step(s, e, 120)
    out: dict[datetime, dict[str, float]] = defaultdict(lambda: {"rx_bps": 0.0, "tx_bps": 0.0})
    store = get_store()
    if ids:
        for metric, key in (("net_rx_bytes_ps", "rx_bps"), ("net_tx_bytes_ps", "tx_bps")):
            for p in await store.metric_series(ctx.org_id, ids, metric, None, s, e, step, "avg"):
                out[p["ts"]][key] += p["value"] * 8
    return {"step": step, "points": [{"ts": ts, **v} for ts, v in sorted(out.items())]}


@router.get("/activity")
async def activity(ctx: Ctx = Depends(require(Permission.VIEW)), limit: int = Query(40, ge=1, le=200)):
    now = datetime.now(UTC)
    return await get_store().events(ctx.org_id, now - timedelta(days=3), now + timedelta(minutes=1), limit=limit)


@router.get("/log-errors")
async def recent_log_errors(ctx: Ctx = Depends(require(Permission.LOGS_READ)), limit: int = Query(10, ge=1, le=100)):
    now = datetime.now(UTC)
    rows, _ = await get_store().search_logs(
        ctx.org_id, LogQuery(start=now - timedelta(hours=24), end=now + timedelta(minutes=1), min_severity="error"),
        limit, None)
    return rows
