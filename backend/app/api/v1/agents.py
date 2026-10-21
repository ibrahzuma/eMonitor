"""Agent enrollment, credential lifecycle and telemetry ingestion."""

from __future__ import annotations

import math
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, RateLimited, Unauthorized, ValidationFailed
from app.core.permissions import Permission
from app.core.ratelimit import client_ip, hit, limiter
from app.core.redis import get_redis
from app.core.security import constant_time_equals, random_token, sha256_hex
from app.models import Agent, EnrollmentToken, Organization, Resource, ServerDetail
from app.models.enums import AgentStatus, ResourceKind
from app.monitoring.evaluator import agent_seen
from app.schemas.common import ORM, Message
from app.services import agent_package, audit
from app.telemetry.ingest import check_backpressure, publish_rows
from app.telemetry.store import SEVERITY_NUM

router = APIRouter(prefix="/agents", tags=["agents"])


# ---------------------------------------------------------------- agent distribution (public)

@router.get("/install.sh", response_class=PlainTextResponse,
            dependencies=[Depends(limiter("agent_dl", "rate_limit_agent_download"))])
async def agent_install_script():
    """Bootstrap installer: `curl -fsSL <server>/api/v1/agents/install.sh | sudo bash -s -- --token <TOKEN>`.

    Public by design (contains no secrets); enrollment still requires a valid token."""
    try:
        script = agent_package.bootstrap_script()
    except FileNotFoundError:
        raise NotFound("Agent package") from None
    return PlainTextResponse(script, media_type="text/x-shellscript",
                             headers={"Cache-Control": "no-cache", "Content-Disposition": "inline; filename=install.sh"})


@router.get("/package.tar.gz", dependencies=[Depends(limiter("agent_dl", "rate_limit_agent_download"))])
async def agent_package_download():
    try:
        pkg = agent_package.build_package()
    except FileNotFoundError:
        raise NotFound("Agent package") from None
    return Response(pkg.data, media_type="application/gzip", headers={
        "Content-Disposition": f"attachment; filename=emonitor-agent-{pkg.version}.tar.gz",
        "X-Checksum-SHA256": pkg.sha256, "Cache-Control": "no-cache"})


class AgentInfo(BaseModel):
    server_url: str
    install_script_url: str
    package_url: str
    agent_version: str
    package_sha256: str
    install_command_template: str
    upgrade_command: str


@router.get("/info", response_model=AgentInfo)
async def agent_info(ctx: Ctx = Depends(require(Permission.VIEW))):
    try:
        pkg = agent_package.build_package()
    except FileNotFoundError:
        raise NotFound("Agent package") from None
    base = agent_package.server_url()
    return AgentInfo(
        server_url=base, install_script_url=f"{base}/api/v1/agents/install.sh",
        package_url=f"{base}/api/v1/agents/package.tar.gz", agent_version=pkg.version, package_sha256=pkg.sha256,
        install_command_template=agent_package.install_command("<ENROLLMENT_TOKEN>"),
        upgrade_command=f"curl -fsSL {base}/api/v1/agents/install.sh | sudo bash -s -- --upgrade",
    )

METRIC_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SECRET_GRACE = timedelta(minutes=10)


# ---------------------------------------------------------------- admin: enrollment tokens

class EnrollmentTokenIn(BaseModel):
    description: str = Field(default="", max_length=200)
    server_id: uuid.UUID | None = None
    max_uses: int = Field(default=1, ge=1, le=1000)
    expires_in_hours: int = Field(default=24, ge=1, le=24 * 30)
    environment: str | None = None
    group_id: uuid.UUID | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)


class EnrollmentTokenOut(ORM):
    id: uuid.UUID
    description: str
    server_id: uuid.UUID | None
    max_uses: int
    use_count: int
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None


class EnrollmentTokenCreated(EnrollmentTokenOut):
    token: str
    install_command: str


@router.get("/enrollment-tokens", response_model=list[EnrollmentTokenOut])
async def list_tokens(ctx: Ctx = Depends(require(Permission.AGENTS_MANAGE)), db: AsyncSession = Depends(get_db)):
    return (await db.scalars(select(EnrollmentToken).where(EnrollmentToken.organization_id == ctx.org_id)
                             .order_by(EnrollmentToken.created_at.desc()).limit(200))).all()


@router.post("/enrollment-tokens", response_model=EnrollmentTokenCreated, status_code=201)
async def create_token(body: EnrollmentTokenIn, ctx: Ctx = Depends(require(Permission.AGENTS_MANAGE)),
                       db: AsyncSession = Depends(get_db)):
    if body.server_id:
        r = await db.scalar(select(Resource).where(Resource.id == body.server_id, Resource.organization_id == ctx.org_id,
                                                   Resource.kind == ResourceKind.SERVER))
        if not r:
            raise ValidationFailed("server not found")
    token = "emt_" + random_token(32)
    rec = EnrollmentToken(
        organization_id=ctx.org_id, token_hash=sha256_hex(token), description=body.description, server_id=body.server_id,
        max_uses=1 if body.server_id else body.max_uses, created_by_id=ctx.user_id,
        expires_at=datetime.now(UTC) + timedelta(hours=body.expires_in_hours),
        defaults={"environment": body.environment, "group_id": str(body.group_id) if body.group_id else None,
                  "tags": body.tags},
    )
    db.add(rec)
    await db.flush()
    audit.record(db, action="agent.enrollment_token_created", ctx=ctx, target_type="enrollment_token", target_id=rec.id,
                 details={"server_id": str(body.server_id) if body.server_id else None, "max_uses": rec.max_uses})
    await db.commit()
    cmd = agent_package.install_command(token)
    return EnrollmentTokenCreated.model_validate({**EnrollmentTokenOut.model_validate(rec).model_dump(),
                                                  "token": token, "install_command": cmd})


@router.delete("/enrollment-tokens/{token_id}", response_model=Message)
async def revoke_token(token_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.AGENTS_MANAGE)),
                       db: AsyncSession = Depends(get_db)):
    rec = await db.scalar(select(EnrollmentToken).where(EnrollmentToken.id == token_id,
                                                        EnrollmentToken.organization_id == ctx.org_id))
    if not rec:
        raise NotFound("Enrollment token")
    rec.revoked_at = datetime.now(UTC)
    audit.record(db, action="agent.enrollment_token_revoked", ctx=ctx, target_type="enrollment_token", target_id=rec.id)
    await db.commit()
    return Message(message="Enrollment token revoked")


class AgentOut(ORM):
    id: uuid.UUID
    server_id: uuid.UUID
    status: str
    version: str
    reported_hostname: str
    last_seen_at: datetime | None
    last_ip: str
    collection_interval_seconds: int
    spool_depth: int
    last_error: str
    enrolled_at: datetime
    revoked_at: datetime | None
    rotated_at: datetime | None
    server_name: str | None = None


@router.get("", response_model=list[AgentOut])
async def list_agents(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Agent, Resource.name).join(Resource, Resource.id == Agent.server_id)
                             .where(Agent.organization_id == ctx.org_id).order_by(Agent.enrolled_at.desc()))).all()
    out = []
    for a, name in rows:
        o = AgentOut.model_validate(a)
        o.server_name = name
        out.append(o)
    return out


@router.post("/{agent_id}/revoke", response_model=Message)
async def revoke_agent(agent_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.AGENTS_MANAGE)),
                       db: AsyncSession = Depends(get_db)):
    a = await db.scalar(select(Agent).where(Agent.id == agent_id, Agent.organization_id == ctx.org_id))
    if not a:
        raise NotFound("Agent")
    a.status = AgentStatus.REVOKED
    a.revoked_at = datetime.now(UTC)
    a.previous_secret_hash = None
    audit.record(db, action="agent.revoked", ctx=ctx, target_type="agent", target_id=a.id)
    from app.incidents.engine import clear_condition

    await clear_condition(db, org_id=ctx.org_id, dedup_key=f"agent:{a.server_id}", message="Agent revoked")
    await events.commit(db)
    return Message(message="Agent credentials revoked")


# ---------------------------------------------------------------- agent-facing endpoints

class EnrollIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    hostname: str = Field(min_length=1, max_length=255)
    agent_version: str = Field(default="", max_length=32)
    os_version: str = Field(default="", max_length=200)
    kernel: str = Field(default="", max_length=200)
    cpu_count: int | None = Field(default=None, ge=1, le=4096)
    memory_total_bytes: int | None = Field(default=None, ge=0)
    ip_address: str = Field(default="", max_length=64)


class EnrollOut(BaseModel):
    agent_id: uuid.UUID
    agent_secret: str
    server_id: uuid.UUID
    organization_id: uuid.UUID
    collection_interval_seconds: int


@router.post("/enroll", response_model=EnrollOut, status_code=201,
             dependencies=[Depends(limiter("enroll", "rate_limit_enroll"))])
async def enroll(body: EnrollIn, request: Request, db: AsyncSession = Depends(get_db)):
    now = datetime.now(UTC)
    rec = await db.scalar(select(EnrollmentToken).where(EnrollmentToken.token_hash == sha256_hex(body.token))
                          .with_for_update())
    if not rec or rec.revoked_at or rec.expires_at <= now or rec.use_count >= rec.max_uses:
        raise Unauthorized("Invalid or expired enrollment token")
    org = await db.get(Organization, rec.organization_id)
    if not org or not org.is_active:
        raise Unauthorized("Invalid or expired enrollment token")
    rec.use_count += 1
    if rec.server_id:
        resource = await db.get(Resource, rec.server_id)
        if not resource:
            raise Unauthorized("Invalid or expired enrollment token")
        # Re-enrollment replaces any existing agent credentials for this server.
        for old in (await db.scalars(select(Agent).where(Agent.server_id == resource.id,
                                                         Agent.status == AgentStatus.ACTIVE))).all():
            old.status, old.revoked_at = AgentStatus.REVOKED, now
    else:
        name = body.hostname[:200]
        n = 1
        while await db.scalar(select(Resource.id).where(Resource.organization_id == org.id,
                                                        Resource.kind == ResourceKind.SERVER, Resource.name == name)):
            n += 1
            name = f"{body.hostname[:190]}-{n}"
        d = rec.defaults or {}
        resource = Resource(organization_id=org.id, kind=ResourceKind.SERVER, name=name, address=body.hostname,
                            environment=d.get("environment") or "production",
                            group_id=uuid.UUID(d["group_id"]) if d.get("group_id") else None, tags=d.get("tags") or [])
        db.add(resource)
        await db.flush()
        db.add(ServerDetail(resource_id=resource.id, organization_id=org.id))
        await db.flush()
    server = await db.get(ServerDetail, resource.id)
    assert server
    server.hostname = body.hostname
    server.ip_address = body.ip_address or server.ip_address or client_ip(request)
    server.os_version, server.kernel = body.os_version, body.kernel
    server.cpu_count, server.memory_total_bytes = body.cpu_count, body.memory_total_bytes
    secret = random_token(32)
    agent = Agent(organization_id=org.id, server_id=resource.id, status=AgentStatus.ACTIVE, secret_hash=sha256_hex(secret),
                  version=body.agent_version, reported_hostname=body.hostname, last_ip=client_ip(request),
                  collection_interval_seconds=server.monitoring_interval_seconds, enrolled_at=now)
    db.add(agent)
    await db.flush()
    audit.record(db, action="agent.enrolled", org_id=org.id, target_type="agent", target_id=agent.id,
                 details={"server_id": str(resource.id), "hostname": body.hostname, "token_id": str(rec.id)},
                 ip=client_ip(request))
    await db.commit()
    return EnrollOut(agent_id=agent.id, agent_secret=secret, server_id=resource.id, organization_id=org.id,
                     collection_interval_seconds=server.monitoring_interval_seconds)


async def get_agent(request: Request, db: AsyncSession = Depends(get_db),
                    authorization: str | None = Header(default=None)) -> Agent:
    if not authorization or not authorization.startswith("Agent "):
        raise Unauthorized("Agent credentials required")
    try:
        agent_id_s, secret = authorization[6:].strip().split(".", 1)
        agent_id = uuid.UUID(agent_id_s)
    except ValueError:
        raise Unauthorized("Malformed agent credentials") from None
    # Rate-limit before touching the database so a slow/unavailable Redis never holds a DB connection.
    allowed, retry = await hit(f"agent:{agent_id}", 240, 60)
    if not allowed:
        raise RateLimited(retry)
    agent = await db.get(Agent, agent_id)
    if not agent or agent.status != AgentStatus.ACTIVE:
        raise Unauthorized("Agent revoked or unknown")
    h = sha256_hex(secret)
    ok = constant_time_equals(agent.secret_hash, h)
    if not ok and agent.previous_secret_hash and agent.previous_secret_valid_until and \
            agent.previous_secret_valid_until > datetime.now(UTC):
        ok = constant_time_equals(agent.previous_secret_hash, h)
    if not ok:
        raise Unauthorized("Invalid agent credentials")
    request.state.agent = agent
    return agent


class RotateOut(BaseModel):
    agent_id: uuid.UUID
    agent_secret: str


@router.post("/rotate", response_model=RotateOut)
async def rotate(agent: Agent = Depends(get_agent), db: AsyncSession = Depends(get_db)):
    now = datetime.now(UTC)
    secret = random_token(32)
    agent.previous_secret_hash = agent.secret_hash
    agent.previous_secret_valid_until = now + SECRET_GRACE
    agent.secret_hash = sha256_hex(secret)
    agent.rotated_at = now
    audit.record(db, action="agent.credentials_rotated", org_id=agent.organization_id, target_type="agent",
                 target_id=agent.id)
    await db.commit()
    return RotateOut(agent_id=agent.id, agent_secret=secret)


class MetricPoint(BaseModel):
    m: str = Field(max_length=64)
    i: str = Field(default="", max_length=128)
    v: float

    @field_validator("m")
    @classmethod
    def _name(cls, v: str) -> str:
        if not METRIC_NAME.match(v):
            raise ValueError("invalid metric name")
        return v

    @field_validator("v")
    @classmethod
    def _finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("metric value must be finite")
        return v


class Sample(BaseModel):
    ts: datetime
    metrics: list[MetricPoint] = Field(max_length=5000)


class SystemInfo(BaseModel):
    os_version: str | None = Field(default=None, max_length=200)
    kernel: str | None = Field(default=None, max_length=200)
    cpu_count: int | None = Field(default=None, ge=1, le=4096)
    memory_total_bytes: int | None = Field(default=None, ge=0)
    uptime_seconds: int | None = Field(default=None, ge=0)
    ip_address: str | None = Field(default=None, max_length=64)


class MetricsIn(BaseModel):
    agent_version: str = Field(default="", max_length=32)
    hostname: str = Field(default="", max_length=255)
    system: SystemInfo | None = None
    samples: list[Sample] = Field(max_length=1000)
    spool_depth: int = Field(default=0, ge=0)
    last_error: str = Field(default="", max_length=1000)


class IngestAck(BaseModel):
    accepted: int
    collection_interval_seconds: int
    server_time: datetime


_SNAPSHOT_METRICS = {"cpu_percent", "memory_percent", "load1", "load5", "load15", "swap_percent", "process_count",
                     "uptime_seconds", "memory_used_bytes", "memory_available_bytes", "tcp_connections"}


@router.post("/metrics", response_model=IngestAck, status_code=202)
async def ingest_metrics(body: MetricsIn, request: Request, agent: Agent = Depends(get_agent),
                         db: AsyncSession = Depends(get_db)):
    s = get_settings()
    now = datetime.now(UTC)
    points = sum(len(x.metrics) for x in body.samples)
    if points > s.max_metrics_per_request:
        raise ValidationFailed(f"too many metric points ({points} > {s.max_metrics_per_request})")
    org = await db.get(Organization, agent.organization_id)
    resource = await db.get(Resource, agent.server_id)
    server = await db.get(ServerDetail, agent.server_id)
    if not org or not resource or not server:
        raise Unauthorized("Agent revoked or unknown")
    retention = int((org.settings or {}).get("metric_retention_days", 90))
    rows: list[dict[str, Any]] = []
    latest: dict[str, Any] = {}
    newest = None
    for sample in body.samples:
        ts = sample.ts if sample.ts.tzinfo else sample.ts.replace(tzinfo=UTC)
        if ts < now - timedelta(hours=24) or ts > now + timedelta(minutes=5):
            continue  # outside accepted clock window; drop rather than corrupt history
        for p in sample.metrics:
            rows.append({"ts": ts, "org_id": org.id, "resource_id": resource.id, "metric": p.m, "instance": p.i,
                         "value": p.v, "source": "agent", "retention_days": retention})
        if newest is None or ts >= newest:
            newest = ts
            snap: dict[str, Any] = {}
            disks: dict[str, float] = {}
            for p in sample.metrics:
                if p.m in _SNAPSHOT_METRICS and not p.i:
                    snap[p.m] = round(p.v, 3)
                elif p.m == "disk_percent":
                    disks[p.i] = round(p.v, 2)
            if disks:
                snap["disk_percent_max"] = max(disks.values())
                snap["disks"] = disks
            latest = snap
    # Raises 503 (with Retry-After) under backpressure; the agent keeps the batch spooled.
    await check_backpressure()
    org_id, resource_id, interval = org.id, resource.id, server.monitoring_interval_seconds
    agent.last_seen_at = now
    agent.last_ip = client_ip(request)
    agent.version = body.agent_version or agent.version
    agent.spool_depth = body.spool_depth
    agent.last_error = body.last_error
    if body.hostname:
        agent.reported_hostname = body.hostname
    if latest:
        server.latest = {**latest, "ts": newest.isoformat() if newest else None}
        server.last_metrics_at = newest
    if body.system:
        for f in ("os_version", "kernel", "cpu_count", "memory_total_bytes", "uptime_seconds"):
            v = getattr(body.system, f)
            if v is not None:
                setattr(server, f, v)
        if body.system.ip_address and not server.ip_address:
            server.ip_address = body.system.ip_address
    await agent_seen(db, org, agent, resource, now)
    events.emit(db, org.id, "metrics", {"resource_id": str(resource.id), "latest": server.latest})
    await events.commit(db)
    await db.close()  # release the connection before handing rows to the ingest pipeline
    await publish_rows("metrics", rows, enforce_backpressure=False,
                       meta={"evaluate": "server_metrics", "org_id": str(org_id), "resource_id": str(resource_id)})
    return IngestAck(accepted=len(rows), collection_interval_seconds=interval, server_time=now)


class LogRecordIn(BaseModel):
    ts: datetime | None = None
    message: str = Field(max_length=65536)
    severity: str = "info"
    source: str = Field(default="", max_length=128)
    application: str = Field(default="", max_length=128)
    service: str = Field(default="", max_length=128)
    environment: str = Field(default="", max_length=32)
    trace_id: str = Field(default="", max_length=128)
    host: str = Field(default="", max_length=255)
    resource_id: uuid.UUID | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator("severity")
    @classmethod
    def _sev(cls, v: str) -> str:
        v = v.lower().strip()
        aliases = {"warn": "warning", "err": "error", "crit": "critical", "fatal": "critical", "emerg": "emergency",
                   "trace": "debug", "information": "info"}
        v = aliases.get(v, v)
        return v if v in SEVERITY_NUM else "info"


class LogsIn(BaseModel):
    records: list[LogRecordIn] = Field(min_length=1, max_length=5000)


async def enforce_log_quota(org: Organization, n: int) -> None:
    quota = int((org.settings or {}).get("logs_per_day_quota", 0) or 0)
    if quota <= 0:
        return
    key = f"emonitor:logquota:{org.id}:{datetime.now(UTC):%Y%m%d}"
    try:
        r = get_redis()
        used = await r.incrby(key, n)
        if used == n:
            await r.expire(key, 2 * 86400)
    except Exception:
        return  # quota accounting is best-effort when Redis is down (backpressure still applies)
    if used > quota:
        raise RateLimited(retry_after=3600)


def build_log_rows(org: Organization, records: list[LogRecordIn], *, default_host: str = "",
                   resource_id: uuid.UUID | None = None, valid_resources: set[uuid.UUID] | None = None,
                   default_env: str = "") -> list[dict[str, Any]]:
    s = get_settings()
    now = datetime.now(UTC)
    retention = int((org.settings or {}).get("log_retention_days", 14))
    rows = []
    for rec in records:
        ts = rec.ts or now
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        if ts < now - timedelta(days=7) or ts > now + timedelta(minutes=5):
            ts = now
        msg = rec.message.encode("utf-8")[: s.max_log_message_bytes].decode("utf-8", errors="ignore")
        rid = resource_id
        if rid is None and rec.resource_id and valid_resources is not None and rec.resource_id in valid_resources:
            rid = rec.resource_id
        attrs = {str(k)[:64]: (v if isinstance(v, str) else str(v))[:1024] for k, v in list(rec.attributes.items())[:50]}
        rows.append({
            "ts": ts, "id": uuid.uuid4(), "org_id": org.id, "resource_id": rid or uuid.UUID(int=0),
            "host": (rec.host or default_host)[:255], "application": rec.application, "service": rec.service,
            "source": rec.source, "environment": rec.environment or default_env, "severity": rec.severity,
            "severity_num": SEVERITY_NUM[rec.severity], "message": msg, "trace_id": rec.trace_id,
            "attributes": attrs, "retention_days": retention,
        })
    return rows


@router.post("/logs", response_model=IngestAck, status_code=202)
async def agent_logs(body: LogsIn, agent: Agent = Depends(get_agent), db: AsyncSession = Depends(get_db)):
    org = await db.get(Organization, agent.organization_id)
    resource = await db.get(Resource, agent.server_id)
    server = await db.get(ServerDetail, agent.server_id)
    if not org or not resource or not server:
        raise Unauthorized("Agent revoked or unknown")
    await enforce_log_quota(org, len(body.records))
    rows = build_log_rows(org, body.records, default_host=server.hostname or resource.name, resource_id=resource.id,
                          default_env=resource.environment)
    await publish_rows("logs", rows)
    events.emit(db, org.id, "logs", {"count": len(rows), "resource_id": str(resource.id)})
    await events.run_deferred(db)
    return IngestAck(accepted=len(rows), collection_interval_seconds=server.monitoring_interval_seconds,
                     server_time=datetime.now(UTC))


class HeartbeatIn(BaseModel):
    agent_version: str = Field(default="", max_length=32)
    spool_depth: int = Field(default=0, ge=0)
    last_error: str = Field(default="", max_length=1000)


@router.post("/heartbeat", response_model=IngestAck)
async def heartbeat(body: HeartbeatIn, request: Request, agent: Agent = Depends(get_agent),
                    db: AsyncSession = Depends(get_db)):
    now = datetime.now(UTC)
    org = await db.get(Organization, agent.organization_id)
    resource = await db.get(Resource, agent.server_id)
    server = await db.get(ServerDetail, agent.server_id)
    if not org or not resource or not server:
        raise Unauthorized("Agent revoked or unknown")
    agent.last_seen_at = now
    agent.last_ip = client_ip(request)
    agent.version = body.agent_version or agent.version
    agent.spool_depth = body.spool_depth
    agent.last_error = body.last_error
    await agent_seen(db, org, agent, resource, now)
    await events.commit(db)
    return IngestAck(accepted=0, collection_interval_seconds=server.monitoring_interval_seconds, server_time=now)
