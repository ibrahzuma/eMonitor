"""Resource inventory: servers, websites/APIs, network devices, services/databases, checks, groups."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import ApiError, NotFound, ValidationFailed
from app.core.permissions import Permission
from app.models import Check, Resource, ResourceDependency, ResourceGroup, ServerDetail
from app.models.enums import CheckType, ResourceKind
from app.monitoring.evaluator import recompute_resource_status
from app.schemas.common import Message, Page, PageParams, resolve_range
from app.schemas.resources import (
    CheckIn,
    CheckOut,
    CheckUpdate,
    DependencyIn,
    DependencyOut,
    GroupIn,
    GroupOut,
    ImportRequest,
    ImportResult,
    NetworkDeviceCreate,
    ResourceCreate,
    ResourceOut,
    ResourceUpdate,
    ServerCreate,
    ServerUpdate,
    ServiceCreate,
    WebsiteCreate,
)
from app.services import audit
from app.services import resources as svc
from app.services.availability import check_availability, combine
from app.telemetry.store import get_store

router = APIRouter(tags=["resources"])

_BASE_FIELDS = ("name", "description", "address", "environment", "location", "business_owner", "group_id", "team_id",
                "tags", "custom_fields", "attributes", "notification_policy_id")
_SERVER_FIELDS = ("hostname", "ip_address", "os_family", "os_version", "monitoring_interval_seconds",
                  "agent_timeout_seconds", "thresholds", "monitored_services")


def _base(body: Any) -> dict[str, Any]:
    return {f: getattr(body, f) for f in _BASE_FIELDS}


async def _list(db: AsyncSession, ctx: Ctx, p: PageParams, kinds: list[str] | None, status: list[str] | None,
                environment: str | None, group_id: uuid.UUID | None, team_id: uuid.UUID | None, tag: list[str] | None,
                q: str | None, sort: str, with_uptime: bool = False) -> Page[ResourceOut]:
    stmt = select(Resource).where(Resource.organization_id == ctx.org_id)
    if kinds:
        stmt = stmt.where(Resource.kind.in_(kinds))
    if status:
        stmt = stmt.where(Resource.status.in_(status))
    if environment:
        stmt = stmt.where(Resource.environment == environment)
    if group_id:
        stmt = stmt.where(Resource.group_id == group_id)
    if team_id:
        stmt = stmt.where(Resource.team_id == team_id)
    if tag:
        stmt = stmt.where(Resource.tags.contains(tag))
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Resource.name).like(like), func.lower(Resource.address).like(like),
                              func.lower(Resource.description).like(like)))
    order = {"name": Resource.name, "-name": Resource.name.desc(), "status": Resource.status,
             "-updated": Resource.status_changed_at.desc(), "created": Resource.created_at}.get(sort, Resource.name)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.scalars(stmt.order_by(order).offset(p.offset).limit(p.page_size))).all()
    items = [await svc.resource_out(db, r, with_checks=True, with_counts=True) for r in rows]
    if with_uptime and items:
        now = datetime.now(UTC)
        checks = (await db.scalars(select(Check).where(Check.resource_id.in_([i.id for i in items]),
                                                       Check.enabled.is_(True)))).all()
        try:
            av = await check_availability(ctx.org_id, list(checks), now - timedelta(hours=24), now)
        except Exception:
            av = {}
        for it in items:
            agg = combine([av[c.id] for c in checks if c.resource_id == it.id and c.id in av])
            it.uptime_24h = agg.uptime_percent if agg else None
    return Page(items=items, total=total or 0, page=p.page, page_size=p.page_size)


@router.get("/resources", response_model=Page[ResourceOut])
async def list_resources(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                         p: PageParams = Depends(), kind: list[ResourceKind] | None = Query(default=None),
                         status: list[str] | None = Query(default=None), environment: str | None = None,
                         group_id: uuid.UUID | None = None, team_id: uuid.UUID | None = None,
                         tag: list[str] | None = Query(default=None), q: str | None = Query(default=None, max_length=200),
                         sort: str = "name", uptime: bool = False):
    return await _list(db, ctx, p, [k.value for k in kind] if kind else None, status, environment, group_id, team_id,
                       tag, q, sort, uptime)


@router.post("/resources", response_model=ResourceOut, status_code=201)
async def create_resource(body: ResourceCreate, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                          db: AsyncSession = Depends(get_db)):
    server = {} if body.kind == ResourceKind.SERVER else None
    r = await svc.create_resource(db, ctx, kind=body.kind, base=_base(body), checks=body.checks, server=server)
    audit.record(db, action="resource.created", ctx=ctx, target_type=body.kind, target_id=r.id, details={"name": r.name})
    await db.commit()
    return await svc.resource_out(db, r)


@router.get("/resources/dependency-map")
async def dependency_map(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    deps = (await db.scalars(select(ResourceDependency).where(ResourceDependency.organization_id == ctx.org_id))).all()
    ids = {d.resource_id for d in deps} | {d.depends_on_id for d in deps}
    nodes = (await db.scalars(select(Resource).where(Resource.id.in_(ids)))).all() if ids else []
    return {
        "nodes": [{"id": str(n.id), "name": n.name, "kind": n.kind, "status": n.status} for n in nodes],
        "edges": [{"id": str(d.id), "from": str(d.resource_id), "to": str(d.depends_on_id), "description": d.description}
                  for d in deps],
    }


@router.post("/resources/import", response_model=ImportResult)
async def import_resources(body: ImportRequest, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                           db: AsyncSession = Depends(get_db)):
    errors: list[dict[str, Any]] = []
    ids: list[uuid.UUID] = []
    for i, raw in enumerate(body.items):
        try:
            item = ResourceCreate.model_validate(raw)
            async with db.begin_nested():
                r = await svc.create_resource(db, ctx, kind=item.kind, base=_base(item), checks=item.checks,
                                              server={} if item.kind == ResourceKind.SERVER else None)
                ids.append(r.id)
        except ValidationError as exc:
            errors.append({"index": i, "errors": [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]})
        except ApiError as exc:
            errors.append({"index": i, "errors": [{"msg": exc.message, "details": exc.details}]})
    if body.dry_run:
        await db.rollback()
        return ImportResult(created=0, errors=errors, ids=[])
    audit.record(db, action="resource.imported", ctx=ctx, target_type="resource",
                 details={"created": len(ids), "errors": len(errors)})
    await db.commit()
    return ImportResult(created=len(ids), errors=errors, ids=ids)


@router.get("/resources/{resource_id}", response_model=ResourceOut)
async def get_resource(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                       db: AsyncSession = Depends(get_db)):
    return await svc.resource_out(db, await svc.get_resource(db, ctx, resource_id))


async def _apply_update(db: AsyncSession, ctx: Ctx, r: Resource, body: ResourceUpdate) -> dict[str, Any]:
    data = body.model_dump(exclude_unset=True)
    await svc.validate_refs(db, ctx, data.get("group_id"), data.get("team_id"), data.get("notification_policy_id"))
    changes: dict[str, Any] = {}
    if "notification_policy_id" in data:
        pid = data.pop("notification_policy_id")
        attrs = dict(r.attributes or {})
        if pid:
            attrs["notification_policy_id"] = str(pid)
        else:
            attrs.pop("notification_policy_id", None)
        r.attributes = attrs
        changes["notification_policy_id"] = str(pid) if pid else None
    if "attributes" in data and data["attributes"] is not None:
        keep = {k: v for k, v in (r.attributes or {}).items() if k == "notification_policy_id"}
        r.attributes = {**data.pop("attributes"), **keep}
        changes["attributes"] = r.attributes
    for f in ("name", "description", "address", "environment", "location", "business_owner", "group_id", "team_id",
              "tags", "custom_fields", "is_paused"):
        if f in data:
            if f in ("name",) and data[f] is None:
                continue
            setattr(r, f, data[f])
            changes[f] = data[f]
    if "name" in changes and await db.scalar(select(Resource.id).where(
            Resource.organization_id == ctx.org_id, Resource.kind == r.kind, Resource.name == r.name,
            Resource.id != r.id)):
        raise ValidationFailed(f"a {r.kind} named {r.name!r} already exists", code="conflict")
    return changes


async def _sync_address_to_checks(db: AsyncSession, ctx: Ctx, r: Resource) -> None:
    """Keep the primary check target in step with the resource address for websites/APIs/devices."""
    from app.core.security import decrypt_json

    checks = (await db.scalars(select(Check).where(Check.resource_id == r.id))).all()
    for c in checks:
        if r.kind in (ResourceKind.WEBSITE, ResourceKind.API) and c.type == CheckType.HTTP:
            new_cfg = {**c.config, "url": r.address}
        elif r.kind == ResourceKind.NETWORK_DEVICE and c.type in (CheckType.ICMP, CheckType.SNMP, CheckType.TCP):
            new_cfg = {**c.config, "host": r.address}
        else:
            continue
        secrets = decrypt_json(c.secret_config_enc) if c.secret_config_enc else None
        c.config, _ = svc.validate_check_payload(ctx, c.type, new_cfg, secrets, c.interval_seconds, c.timeout_seconds)
        c.next_run_at = datetime.now(UTC)


@router.patch("/resources/{resource_id}", response_model=ResourceOut)
async def update_resource(resource_id: uuid.UUID, body: ResourceUpdate,
                          ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)), db: AsyncSession = Depends(get_db)):
    r = await svc.get_resource(db, ctx, resource_id, lock=True)
    changes = await _apply_update(db, ctx, r, body)
    if "address" in changes and r.address:
        await _sync_address_to_checks(db, ctx, r)
    if "is_paused" in changes:
        await recompute_resource_status(db, r)
    audit.record(db, action="resource.updated", ctx=ctx, target_type=r.kind, target_id=r.id, details=changes)
    await events.commit(db)
    return await svc.resource_out(db, r)


@router.delete("/resources/{resource_id}", response_model=Message)
async def delete_resource(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                          db: AsyncSession = Depends(get_db)):
    r = await svc.get_resource(db, ctx, resource_id)
    audit.record(db, action="resource.deleted", ctx=ctx, target_type=r.kind, target_id=r.id, details={"name": r.name})
    await db.delete(r)
    await db.commit()
    return Message(message="Resource deleted; historical telemetry is retained until it expires")


@router.get("/resources/{resource_id}/events")
async def resource_events(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                          db: AsyncSession = Depends(get_db), range: str = "7d", limit: int = Query(200, le=2000)):
    await svc.get_resource(db, ctx, resource_id)
    start, end = resolve_range(range, None, None)
    return await get_store().events(ctx.org_id, start, end, resource_id=resource_id, limit=limit)


@router.get("/resources/{resource_id}/availability")
async def resource_availability(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                                db: AsyncSession = Depends(get_db), range: str | None = "24h",
                                start: datetime | None = None, end: datetime | None = None):
    await svc.get_resource(db, ctx, resource_id)
    s, e = resolve_range(range, start, end)
    checks = list((await db.scalars(select(Check).where(Check.resource_id == resource_id))).all())
    av = await check_availability(ctx.org_id, checks, s, e)
    total = combine(list(av.values()))
    return {"start": s, "end": e, "resource": total.as_dict() if total else None,
            "checks": [{"check_id": str(c.id), "name": c.name, "type": c.type, **av[c.id].as_dict()} for c in checks]}


# ---------------------------------------------------------------- dependencies

@router.get("/resources/{resource_id}/dependencies", response_model=list[DependencyOut])
async def list_dependencies(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                            db: AsyncSession = Depends(get_db)):
    await svc.get_resource(db, ctx, resource_id)
    return (await db.scalars(select(ResourceDependency).where(
        ResourceDependency.organization_id == ctx.org_id,
        or_(ResourceDependency.resource_id == resource_id, ResourceDependency.depends_on_id == resource_id)))).all()


@router.post("/resources/{resource_id}/dependencies", response_model=DependencyOut, status_code=201)
async def add_dependency(resource_id: uuid.UUID, body: DependencyIn,
                         ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)), db: AsyncSession = Depends(get_db)):
    await svc.get_resource(db, ctx, resource_id)
    await svc.get_resource(db, ctx, body.depends_on_id)
    if resource_id == body.depends_on_id:
        raise ValidationFailed("a resource cannot depend on itself")
    if await db.scalar(select(ResourceDependency.id).where(ResourceDependency.resource_id == resource_id,
                                                           ResourceDependency.depends_on_id == body.depends_on_id)):
        raise ValidationFailed("dependency already exists", code="conflict")
    # reject cycles
    frontier, seen = {body.depends_on_id}, set()
    while frontier:
        if resource_id in frontier:
            raise ValidationFailed("dependency would create a cycle")
        seen |= frontier
        frontier = set((await db.scalars(select(ResourceDependency.depends_on_id).where(
            ResourceDependency.resource_id.in_(frontier)))).all()) - seen
    dep = ResourceDependency(organization_id=ctx.org_id, resource_id=resource_id, depends_on_id=body.depends_on_id,
                             description=body.description)
    db.add(dep)
    await db.commit()
    return dep


@router.delete("/resources/{resource_id}/dependencies/{dep_id}", response_model=Message)
async def delete_dependency(resource_id: uuid.UUID, dep_id: uuid.UUID,
                            ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)), db: AsyncSession = Depends(get_db)):
    dep = await db.scalar(select(ResourceDependency).where(ResourceDependency.id == dep_id,
                                                           ResourceDependency.organization_id == ctx.org_id))
    if not dep:
        raise NotFound("Dependency")
    await db.delete(dep)
    await db.commit()
    return Message(message="Dependency removed")


# ---------------------------------------------------------------- checks

@router.get("/resources/{resource_id}/checks", response_model=list[CheckOut])
async def list_checks(resource_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                      db: AsyncSession = Depends(get_db)):
    await svc.get_resource(db, ctx, resource_id)
    rows = (await db.scalars(select(Check).where(Check.resource_id == resource_id).order_by(Check.created_at))).all()
    return [svc.check_out(c) for c in rows]


@router.post("/resources/{resource_id}/checks", response_model=CheckOut, status_code=201)
async def add_check(resource_id: uuid.UUID, body: CheckIn, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                    db: AsyncSession = Depends(get_db)):
    r = await svc.get_resource(db, ctx, resource_id)
    c = svc.new_check(ctx, r, body)
    db.add(c)
    await db.flush()
    audit.record(db, action="check.created", ctx=ctx, target_type="check", target_id=c.id,
                 details={"resource": r.name, "type": c.type, "config": c.config})
    await db.commit()
    return svc.check_out(c)


@router.get("/checks/{check_id}", response_model=CheckOut)
async def get_check(check_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    return svc.check_out(await svc.get_check(db, ctx, check_id))


@router.patch("/checks/{check_id}", response_model=CheckOut)
async def update_check(check_id: uuid.UUID, body: CheckUpdate, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                       db: AsyncSession = Depends(get_db)):
    c = await svc.get_check(db, ctx, check_id)
    changes = svc.apply_check_update(ctx, c, body)
    if body.enabled is False:
        r = await db.get(Resource, c.resource_id)
        await db.flush()
        if r:
            await recompute_resource_status(db, r)
    audit.record(db, action="check.updated", ctx=ctx, target_type="check", target_id=c.id, details=changes)
    await events.commit(db)
    return svc.check_out(c)


@router.delete("/checks/{check_id}", response_model=Message)
async def delete_check(check_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                       db: AsyncSession = Depends(get_db)):
    c = await svc.get_check(db, ctx, check_id)
    r = await db.get(Resource, c.resource_id)
    audit.record(db, action="check.deleted", ctx=ctx, target_type="check", target_id=c.id, details={"name": c.name})
    await db.delete(c)
    await db.flush()
    if r:
        await recompute_resource_status(db, r)
    await events.commit(db)
    return Message(message="Check deleted")


@router.post("/checks/{check_id}/run", response_model=Message, status_code=202)
async def run_check_now(check_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                        db: AsyncSession = Depends(get_db)):
    """Schedule the check for immediate execution by the workers (never runs in the request)."""
    c = await svc.get_check(db, ctx, check_id)
    if not c.enabled:
        raise ValidationFailed("check is disabled")
    c.next_run_at = datetime.now(UTC)
    await db.commit()
    return Message(message="Check scheduled for immediate execution")


@router.get("/checks/{check_id}/results")
async def check_results(check_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                        db: AsyncSession = Depends(get_db), range: str | None = "24h", start: datetime | None = None,
                        end: datetime | None = None, status: list[str] | None = Query(default=None),
                        limit: int = Query(500, ge=1, le=5000)):
    await svc.get_check(db, ctx, check_id)
    s, e = resolve_range(range, start, end)
    return await get_store().check_results(ctx.org_id, check_id, s, e, limit=limit, statuses=status)


@router.get("/checks/{check_id}/timeseries")
async def check_timeseries(check_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)),
                           db: AsyncSession = Depends(get_db), range: str | None = "24h", start: datetime | None = None,
                           end: datetime | None = None, bucket: int | None = Query(default=None, ge=60, le=86400)):
    from app.schemas.common import auto_step

    c = await svc.get_check(db, ctx, check_id)
    s, e = resolve_range(range, start, end)
    b = bucket or max(c.interval_seconds, auto_step(s, e, 200))
    return {"bucket_seconds": b, "points": await get_store().check_buckets(ctx.org_id, [check_id], s, e, b)}


# ---------------------------------------------------------------- servers

@router.get("/servers", response_model=Page[ResourceOut])
async def list_servers(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                       p: PageParams = Depends(), status: list[str] | None = Query(default=None),
                       environment: str | None = None, group_id: uuid.UUID | None = None,
                       tag: list[str] | None = Query(default=None), q: str | None = None, sort: str = "name"):
    return await _list(db, ctx, p, [ResourceKind.SERVER], status, environment, group_id, None, tag, q, sort)


@router.post("/servers", response_model=ResourceOut, status_code=201)
async def create_server(body: ServerCreate, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                        db: AsyncSession = Depends(get_db)):
    base = _base(body)
    base["address"] = base["address"] or body.hostname or body.ip_address
    checks = []
    if body.ping_check:
        host = body.ip_address or body.hostname
        if not host:
            raise ValidationFailed("hostname or ip_address is required for a ping check")
        checks.append(CheckIn(name="Ping", type=CheckType.ICMP, config={"host": host, "count": 3},
                              interval_seconds=60, timeout_seconds=10, failure_threshold=3))
    server = {f: getattr(body, f) for f in _SERVER_FIELDS}
    r = await svc.create_resource(db, ctx, kind=ResourceKind.SERVER, base=base, checks=checks, server=server)
    audit.record(db, action="server.created", ctx=ctx, target_type="server", target_id=r.id, details={"name": r.name})
    await db.commit()
    await db.refresh(r)
    return await svc.resource_out(db, r)


@router.patch("/servers/{resource_id}", response_model=ResourceOut)
async def update_server(resource_id: uuid.UUID, body: ServerUpdate,
                        ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)), db: AsyncSession = Depends(get_db)):
    r = await svc.get_resource(db, ctx, resource_id, kind=ResourceKind.SERVER, lock=True)
    changes = await _apply_update(db, ctx, r, body)
    sd = await db.get(ServerDetail, r.id)
    assert sd
    data = body.model_dump(exclude_unset=True)
    for f in _SERVER_FIELDS:
        if f in data and data[f] is not None:
            setattr(sd, f, data[f])
            changes[f] = data[f]
    audit.record(db, action="server.updated", ctx=ctx, target_type="server", target_id=r.id, details=changes)
    await events.commit(db)
    await db.refresh(r)
    return await svc.resource_out(db, r)


# ---------------------------------------------------------------- websites & APIs

@router.get("/websites", response_model=Page[ResourceOut])
async def list_websites(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                        p: PageParams = Depends(), status: list[str] | None = Query(default=None),
                        environment: str | None = None, tag: list[str] | None = Query(default=None),
                        q: str | None = None, sort: str = "name"):
    return await _list(db, ctx, p, [ResourceKind.WEBSITE, ResourceKind.API], status, environment, None, None, tag, q,
                       sort, with_uptime=True)


@router.post("/websites", response_model=ResourceOut, status_code=201)
async def create_website(body: WebsiteCreate, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                         db: AsyncSession = Depends(get_db)):
    base = _base(body)
    base["address"] = body.url
    config = {
        "url": body.url, "method": body.method, "expected_status": body.expected_status, "keyword": body.keyword,
        "keyword_absent": body.keyword_absent, "headers": body.headers, "body": body.body,
        "expected_headers": body.expected_headers, "json_assertions": body.json_assertions, "verify_tls": body.verify_tls,
        "ssl_check": body.ssl_check, "ssl_alert_days": body.ssl_alert_days,
        "degraded_threshold_ms": body.degraded_threshold_ms, "follow_redirects": body.follow_redirects,
    }
    check = CheckIn(name="HTTP", type=CheckType.HTTP, config=config, secrets=body.secrets,
                    interval_seconds=body.interval_seconds, timeout_seconds=body.timeout_seconds,
                    failure_threshold=body.failure_threshold, severity=body.severity)
    r = await svc.create_resource(db, ctx, kind=body.kind, base=base, checks=[check])
    audit.record(db, action="website.created", ctx=ctx, target_type=body.kind, target_id=r.id,
                 details={"name": r.name, "url": body.url})
    await db.commit()
    return await svc.resource_out(db, r)


# ---------------------------------------------------------------- network devices

@router.get("/network-devices", response_model=Page[ResourceOut])
async def list_devices(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                       p: PageParams = Depends(), status: list[str] | None = Query(default=None),
                       q: str | None = None, tag: list[str] | None = Query(default=None), sort: str = "name"):
    return await _list(db, ctx, p, [ResourceKind.NETWORK_DEVICE], status, None, None, None, tag, q, sort,
                       with_uptime=True)


@router.post("/network-devices", response_model=ResourceOut, status_code=201)
async def create_device(body: NetworkDeviceCreate, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                        db: AsyncSession = Depends(get_db)):
    base = _base(body)
    base["address"] = body.host
    base["attributes"] = {**(base.get("attributes") or {}), "vendor": body.vendor, "model": body.model,
                          "device_type": body.device_type}
    checks = []
    if body.ping:
        checks.append(CheckIn(name="Ping", type=CheckType.ICMP, config={"host": body.host, "count": 4},
                              interval_seconds=body.ping_interval_seconds, timeout_seconds=min(10, body.ping_interval_seconds - 1),
                              failure_threshold=3))
    if body.snmp is not None:
        checks.append(CheckIn(name="SNMP", type=CheckType.SNMP, config={**body.snmp, "host": body.host},
                              secrets=body.snmp_secrets, interval_seconds=body.snmp_interval_seconds,
                              timeout_seconds=min(20, body.snmp_interval_seconds - 1), failure_threshold=2,
                              severity="high"))
    if not checks:
        raise ValidationFailed("enable ping and/or SNMP monitoring")
    r = await svc.create_resource(db, ctx, kind=ResourceKind.NETWORK_DEVICE, base=base, checks=checks)
    audit.record(db, action="network_device.created", ctx=ctx, target_type="network_device", target_id=r.id,
                 details={"name": r.name, "host": body.host})
    await db.commit()
    return await svc.resource_out(db, r)


# ---------------------------------------------------------------- services, databases, applications

@router.get("/services", response_model=Page[ResourceOut])
async def list_services(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                        p: PageParams = Depends(), kind: list[str] | None = Query(default=None),
                        status: list[str] | None = Query(default=None), q: str | None = None,
                        tag: list[str] | None = Query(default=None), sort: str = "name"):
    kinds = kind or [ResourceKind.SERVICE, ResourceKind.DATABASE, ResourceKind.APPLICATION]
    return await _list(db, ctx, p, kinds, status, None, None, None, tag, q, sort, with_uptime=True)


@router.post("/services", response_model=ResourceOut, status_code=201)
async def create_service(body: ServiceCreate, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                         db: AsyncSession = Depends(get_db)):
    r = await svc.create_resource(db, ctx, kind=body.kind, base=_base(body), checks=body.checks)
    audit.record(db, action="service.created", ctx=ctx, target_type=body.kind, target_id=r.id, details={"name": r.name})
    await db.commit()
    return await svc.resource_out(db, r)


# ---------------------------------------------------------------- groups

@router.get("/groups", response_model=list[GroupOut])
async def list_groups(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    groups = (await db.scalars(select(ResourceGroup).where(ResourceGroup.organization_id == ctx.org_id)
                               .order_by(ResourceGroup.name))).all()
    counts = dict((await db.execute(select(Resource.group_id, func.count()).where(
        Resource.organization_id == ctx.org_id, Resource.group_id.is_not(None)).group_by(Resource.group_id))).all())
    out = []
    for g in groups:
        o = GroupOut.model_validate(g)
        o.resource_count = counts.get(g.id, 0)
        out.append(o)
    return out


async def _validate_parent(db: AsyncSession, ctx: Ctx, group_id: uuid.UUID | None, parent_id: uuid.UUID | None) -> None:
    if not parent_id:
        return
    cur: uuid.UUID | None = parent_id
    depth = 0
    while cur:
        if cur == group_id:
            raise ValidationFailed("group hierarchy would contain a cycle")
        g = await db.scalar(select(ResourceGroup).where(ResourceGroup.id == cur, ResourceGroup.organization_id == ctx.org_id))
        if not g:
            raise ValidationFailed("parent group not found")
        cur = g.parent_id
        depth += 1
        if depth > 10:
            raise ValidationFailed("groups may be nested at most 10 levels deep")


@router.post("/groups", response_model=GroupOut, status_code=201)
async def create_group(body: GroupIn, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                       db: AsyncSession = Depends(get_db)):
    await _validate_parent(db, ctx, None, body.parent_id)
    g = ResourceGroup(organization_id=ctx.org_id, name=body.name, description=body.description, parent_id=body.parent_id)
    db.add(g)
    try:
        await db.flush()
    except Exception:
        raise ValidationFailed("a group with this name already exists here", code="conflict") from None
    await db.commit()
    return GroupOut.model_validate(g)


@router.put("/groups/{group_id}", response_model=GroupOut)
async def update_group(group_id: uuid.UUID, body: GroupIn, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                       db: AsyncSession = Depends(get_db)):
    g = await db.scalar(select(ResourceGroup).where(ResourceGroup.id == group_id, ResourceGroup.organization_id == ctx.org_id))
    if not g:
        raise NotFound("Group")
    await _validate_parent(db, ctx, g.id, body.parent_id)
    g.name, g.description, g.parent_id = body.name, body.description, body.parent_id
    await db.commit()
    return GroupOut.model_validate(g)


@router.delete("/groups/{group_id}", response_model=Message)
async def delete_group(group_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.RESOURCES_WRITE)),
                       db: AsyncSession = Depends(get_db)):
    g = await db.scalar(select(ResourceGroup).where(ResourceGroup.id == group_id, ResourceGroup.organization_id == ctx.org_id))
    if not g:
        raise NotFound("Group")
    await db.delete(g)
    await db.commit()
    return Message(message="Group deleted; its resources are now ungrouped")
