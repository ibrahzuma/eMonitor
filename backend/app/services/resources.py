"""Resource and check management with tenant-scoped lookups and target authorization."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import Ctx
from app.core.errors import NotFound, ValidationFailed
from app.core.security import decrypt_json, encrypt_json
from app.models import Agent, Check, Incident, Resource, ResourceGroup, ServerDetail, Team
from app.models.enums import OPEN_INCIDENT_STATUSES, ResourceKind
from app.monitoring import netguard
from app.monitoring.check_configs import parse_config, parse_secrets, target_host
from app.schemas.resources import CheckIn, CheckOut, CheckUpdate, ResourceOut


async def get_resource(db: AsyncSession, ctx: Ctx, resource_id: uuid.UUID, kind: str | list[str] | None = None,
                       lock: bool = False) -> Resource:
    stmt = select(Resource).where(Resource.id == resource_id, Resource.organization_id == ctx.org_id)
    if kind:
        stmt = stmt.where(Resource.kind.in_([kind] if isinstance(kind, str) else kind))
    if lock:
        stmt = stmt.with_for_update()
    r = await db.scalar(stmt)
    if not r:
        raise NotFound("Resource")
    return r


async def get_check(db: AsyncSession, ctx: Ctx, check_id: uuid.UUID) -> Check:
    c = await db.scalar(select(Check).where(Check.id == check_id, Check.organization_id == ctx.org_id))
    if not c:
        raise NotFound("Check")
    return c


async def validate_refs(db: AsyncSession, ctx: Ctx, group_id: uuid.UUID | None, team_id: uuid.UUID | None,
                        policy_id: uuid.UUID | None = None) -> None:
    if group_id and not await db.scalar(select(ResourceGroup.id).where(
            ResourceGroup.id == group_id, ResourceGroup.organization_id == ctx.org_id)):
        raise ValidationFailed("group not found")
    if team_id and not await db.scalar(select(Team.id).where(Team.id == team_id, Team.organization_id == ctx.org_id)):
        raise ValidationFailed("team not found")
    if policy_id:
        from app.models import NotificationPolicy

        if not await db.scalar(select(NotificationPolicy.id).where(
                NotificationPolicy.id == policy_id, NotificationPolicy.organization_id == ctx.org_id)):
            raise ValidationFailed("notification policy not found")


def _pyd_errors(exc: ValidationError) -> list[dict[str, Any]]:
    return [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]


def validate_check_payload(ctx: Ctx, check_type: str, config: dict[str, Any], secrets: dict[str, Any] | None,
                           interval: int, timeout: float) -> tuple[dict[str, Any], dict[str, Any] | None]:
    s = get_settings()
    try:
        cfg = parse_config(check_type, config)
    except ValidationError as exc:
        raise ValidationFailed("invalid check configuration", details=_pyd_errors(exc)) from None
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from None
    try:
        sec = parse_secrets(check_type, secrets)
    except ValidationError as exc:
        raise ValidationFailed("invalid check secrets", details=_pyd_errors(exc)) from None
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from None
    if interval < s.min_check_interval_seconds:
        raise ValidationFailed(f"interval must be at least {s.min_check_interval_seconds}s")
    if timeout >= interval:
        raise ValidationFailed("timeout must be shorter than the interval")
    host = target_host(check_type, cfg)
    if host:
        try:
            netguard.static_validate(host, netguard.Scope.from_org(ctx.org.monitoring_scope))
        except netguard.TargetNotAllowed as exc:
            raise ValidationFailed(f"target not allowed: {exc}", code="target_not_allowed") from None
    secret_dict = sec.model_dump(exclude_none=True) if sec is not None else None
    if secret_dict is not None and not any(v for v in secret_dict.values()):
        secret_dict = None
    return cfg.model_dump(mode="json"), secret_dict


def new_check(ctx: Ctx, resource: Resource, body: CheckIn) -> Check:
    config, secrets = validate_check_payload(ctx, body.type, body.config, body.secrets, body.interval_seconds,
                                             body.timeout_seconds)
    return Check(
        organization_id=ctx.org_id, resource_id=resource.id, name=body.name, type=body.type, config=config,
        secret_config_enc=encrypt_json(secrets) if secrets else None, interval_seconds=body.interval_seconds,
        timeout_seconds=body.timeout_seconds, failure_threshold=body.failure_threshold,
        recovery_threshold=body.recovery_threshold, severity=body.severity, enabled=body.enabled,
        next_run_at=datetime.now(UTC) + timedelta(seconds=2),
    )


def apply_check_update(ctx: Ctx, check: Check, body: CheckUpdate) -> dict[str, Any]:
    data = body.model_dump(exclude_unset=True)
    changes: dict[str, Any] = {}
    interval = data.get("interval_seconds") or check.interval_seconds
    timeout = data.get("timeout_seconds") or check.timeout_seconds
    if "config" in data or "secrets" in data or "interval_seconds" in data or "timeout_seconds" in data:
        old_secrets = decrypt_json(check.secret_config_enc) if check.secret_config_enc else {}
        new_secrets = None
        if data.get("secrets") is not None:
            # Merge: provided keys replace stored values; empty-string values clear them.
            new_secrets = {**old_secrets, **data["secrets"]}
            new_secrets = {k: v for k, v in new_secrets.items() if v not in ("", None)}
        config, secrets = validate_check_payload(ctx, check.type, data.get("config", check.config),
                                                 new_secrets if new_secrets is not None else old_secrets or None,
                                                 interval, timeout)
        if "config" in data:
            check.config = config
            changes["config"] = config
        if data.get("secrets") is not None:
            check.secret_config_enc = encrypt_json(secrets) if secrets else None
            changes["secrets"] = "updated"
    for f in ("name", "interval_seconds", "timeout_seconds", "failure_threshold", "recovery_threshold", "severity",
              "enabled"):
        if f in data and data[f] is not None:
            setattr(check, f, data[f])
            changes[f] = data[f]
    if "interval_seconds" in data or data.get("enabled"):
        check.next_run_at = datetime.now(UTC) + timedelta(seconds=2)
    return changes


def check_out(c: Check) -> CheckOut:
    out = CheckOut.model_validate(c)
    out.has_secrets = bool(c.secret_config_enc)
    return out


async def resource_out(db: AsyncSession, r: Resource, *, with_checks: bool = True, with_counts: bool = True) -> ResourceOut:
    out = ResourceOut.model_validate({c.key: getattr(r, c.key) for c in Resource.__table__.columns})
    if r.kind == ResourceKind.SERVER:
        from app.schemas.resources import ServerDetailOut

        sd = await db.get(ServerDetail, r.id)
        if sd is not None:
            out.server = ServerDetailOut.model_validate(sd)
        agent = await db.scalar(select(Agent).where(Agent.server_id == r.id, Agent.status != "revoked")
                                .order_by(Agent.enrolled_at.desc()).limit(1))
        if agent:
            from app.schemas.resources import AgentBrief

            out.agent = AgentBrief.model_validate(agent)
    if with_checks:
        checks = (await db.scalars(select(Check).where(Check.resource_id == r.id).order_by(Check.created_at))).all()
        out.checks = [check_out(c) for c in checks]
    if with_counts:
        out.open_incidents = await db.scalar(select(func.count()).select_from(Incident).where(
            Incident.resource_id == r.id, Incident.status.in_([s.value for s in OPEN_INCIDENT_STATUSES])))
    return out


async def create_resource(db: AsyncSession, ctx: Ctx, *, kind: str, base: dict[str, Any], checks: list[CheckIn],
                          server: dict[str, Any] | None = None) -> Resource:
    policy_id = base.pop("notification_policy_id", None)
    await validate_refs(db, ctx, base.get("group_id"), base.get("team_id"), policy_id)
    if await db.scalar(select(Resource.id).where(Resource.organization_id == ctx.org_id, Resource.kind == kind,
                                                 Resource.name == base["name"])):
        raise ValidationFailed(f"a {kind} named {base['name']!r} already exists", code="conflict")
    attrs = dict(base.pop("attributes", {}) or {})
    if policy_id:
        attrs["notification_policy_id"] = str(policy_id)
    r = Resource(organization_id=ctx.org_id, kind=kind, attributes=attrs, **base)
    db.add(r)
    await db.flush()
    if kind == ResourceKind.SERVER:
        db.add(ServerDetail(resource_id=r.id, organization_id=ctx.org_id, **(server or {})))
    for c in checks:
        db.add(new_check(ctx, r, c))
    await db.flush()
    return r
