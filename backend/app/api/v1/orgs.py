"""Organizations, users/memberships, teams, API keys and audit logs."""

from __future__ import annotations

import ipaddress
import re
import uuid
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import Ctx, Principal, require, require_superadmin
from app.core.errors import Conflict, Forbidden, NotFound, ValidationFailed
from app.core.permissions import API_KEY_SCOPES, ASSIGNABLE_ROLES, ROLE_RANK, Permission
from app.core.security import generate_api_key, hash_password, validate_password_strength
from app.models import ApiKey, AuditLog, Membership, Organization, Team, User
from app.models.enums import Role
from app.models.tenancy import default_org_settings, default_thresholds
from app.schemas.common import ORM, Message, Page, PageParams
from app.services import audit

router = APIRouter(tags=["organizations"])


# ---------------------------------------------------------------- organizations

class OrgOut(ORM):
    id: uuid.UUID
    name: str
    slug: str
    timezone: str
    is_active: bool
    settings: dict[str, Any]
    thresholds: dict[str, Any]
    monitoring_scope: dict[str, Any]
    created_at: datetime


class OrgCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    slug: str = Field(min_length=2, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    timezone: str = "UTC"
    admin_email: EmailStr | None = None  # existing user to make Organization Administrator


class ThresholdPair(BaseModel):
    warning: float | None = Field(default=None, ge=0)
    critical: float | None = Field(default=None, ge=0)


class ScopeIn(BaseModel):
    allow_public: bool = True
    cidrs: list[str] = Field(default_factory=list, max_length=200)
    hostnames: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("cidrs")
    @classmethod
    def _cidrs(cls, v: list[str]) -> list[str]:
        out = []
        for c in v:
            try:
                net = ipaddress.ip_network(c.strip(), strict=False)
            except ValueError:
                raise ValueError(f"invalid CIDR {c!r}") from None
            if net.prefixlen == 0:
                raise ValueError("the whole address space cannot be authorized")
            out.append(str(net))
        return out

    @field_validator("hostnames")
    @classmethod
    def _hosts(cls, v: list[str]) -> list[str]:
        out = []
        for h in v:
            h = h.strip().lower()
            if not re.fullmatch(r"\.?[a-z0-9_]([a-z0-9_\-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_\-]*[a-z0-9_])?)*", h):
                raise ValueError(f"invalid hostname pattern {h!r}")
            out.append(h)
        return out


class OrgUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    timezone: str | None = None
    settings: dict[str, Any] | None = None
    thresholds: dict[str, ThresholdPair] | None = None
    monitoring_scope: ScopeIn | None = None


_SETTING_BOUNDS = {
    "session_idle_minutes": (5, 1440), "reopen_window_minutes": (0, 10080), "agent_timeout_seconds": (30, 86400),
    "log_retention_days": (1, 3650), "metric_retention_days": (1, 3650), "logs_per_day_quota": (0, 10**10),
    "unreachable_after_failures": (1, 100), "metric_consecutive_samples": (1, 100),
}


def _validate_settings(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = {**default_org_settings(), **(current or {})}
    for k, v in patch.items():
        if k == "ssl_alert_days":
            if not isinstance(v, list) or not all(isinstance(x, int) and 0 <= x <= 365 for x in v) or len(v) > 10:
                raise ValidationFailed("ssl_alert_days must be a list of up to 10 integers between 0 and 365")
            merged[k] = sorted(set(v), reverse=True)
            continue
        if k not in _SETTING_BOUNDS:
            raise ValidationFailed(f"unknown setting {k!r}")
        lo, hi = _SETTING_BOUNDS[k]
        if not isinstance(v, int) or not lo <= v <= hi:
            raise ValidationFailed(f"{k} must be an integer between {lo} and {hi}")
        merged[k] = v
    return merged


def _validate_tz(tz: str) -> str:
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValidationFailed(f"unknown time zone {tz!r}") from None
    return tz


@router.get("/organizations", response_model=list[OrgOut])
async def list_orgs(principal: Principal = Depends(require_superadmin), db: AsyncSession = Depends(get_db)):
    return (await db.scalars(select(Organization).order_by(Organization.name))).all()


@router.post("/organizations", response_model=OrgOut, status_code=201)
async def create_org(body: OrgCreate, principal: Principal = Depends(require_superadmin),
                     db: AsyncSession = Depends(get_db)):
    if await db.scalar(select(Organization.id).where(Organization.slug == body.slug)):
        raise Conflict("an organization with this slug already exists")
    org = Organization(name=body.name, slug=body.slug, timezone=_validate_tz(body.timezone),
                       settings=default_org_settings(), thresholds=default_thresholds(),
                       monitoring_scope={"allow_public": True, "cidrs": [], "hostnames": []})
    db.add(org)
    await db.flush()
    if body.admin_email:
        user = await db.scalar(select(User).where(func.lower(User.email) == body.admin_email.lower()))
        if not user:
            raise ValidationFailed("admin_email does not belong to an existing user")
        db.add(Membership(user_id=user.id, organization_id=org.id, role=Role.ORG_ADMIN))
    audit.record(db, action="organization.created", principal=principal, org_id=org.id, target_type="organization",
                 target_id=org.id, details={"name": org.name, "slug": org.slug})
    await db.commit()
    return org


@router.get("/organizations/current", response_model=OrgOut)
async def current_org(ctx: Ctx = Depends(require(Permission.VIEW))):
    return ctx.org


@router.patch("/organizations/current", response_model=OrgOut)
async def update_org(body: OrgUpdate, ctx: Ctx = Depends(require(Permission.ORG_SETTINGS)),
                     db: AsyncSession = Depends(get_db)):
    org = await db.get(Organization, ctx.org_id)
    assert org
    changes: dict[str, Any] = {}
    if body.name is not None:
        org.name = body.name
        changes["name"] = body.name
    if body.timezone is not None:
        org.timezone = _validate_tz(body.timezone)
        changes["timezone"] = org.timezone
    if body.settings is not None:
        org.settings = _validate_settings(org.settings, body.settings)
        changes["settings"] = body.settings
    if body.thresholds is not None:
        merged = dict(org.thresholds or {})
        for k, v in body.thresholds.items():
            if not re.fullmatch(r"[a-z_]{2,64}", k):
                raise ValidationFailed(f"invalid metric name {k!r}")
            if v.warning is not None and v.critical is not None and v.warning > v.critical:
                raise ValidationFailed(f"{k}: warning must not exceed critical")
            merged[k] = v.model_dump(exclude_none=True)
        org.thresholds = merged
        changes["thresholds"] = merged
    if body.monitoring_scope is not None:
        org.monitoring_scope = body.monitoring_scope.model_dump()
        changes["monitoring_scope"] = org.monitoring_scope
    audit.record(db, action="organization.updated", ctx=ctx, target_type="organization", target_id=org.id,
                 details=changes)
    await db.commit()
    return org


# ---------------------------------------------------------------- members / users

class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    full_name: str
    role: str
    is_active: bool
    totp_enabled: bool
    last_login_at: datetime | None
    created_at: datetime


class MemberCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(default="", max_length=200)
    role: Role
    password: str | None = Field(default=None, max_length=1024)  # required when the user does not exist yet


class MemberUpdate(BaseModel):
    role: Role | None = None
    is_active: bool | None = None
    full_name: str | None = Field(default=None, max_length=200)


def _check_role_assignable(ctx: Ctx, role: Role) -> None:
    if role not in ASSIGNABLE_ROLES:
        raise ValidationFailed("role cannot be assigned")
    if ctx.role != Role.SUPER_ADMIN and ROLE_RANK[role] > ROLE_RANK[ctx.role]:
        raise Forbidden("cannot grant a role higher than your own")


@router.get("/users", response_model=Page[MemberOut])
async def list_members(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                       p: PageParams = Depends(), q: str | None = Query(default=None, max_length=100)):
    stmt = select(Membership, User).join(User, User.id == Membership.user_id).where(
        Membership.organization_id == ctx.org_id)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like)))
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.execute(stmt.order_by(User.email).offset(p.offset).limit(p.page_size))).all()
    items = [MemberOut(user_id=u.id, email=u.email, full_name=u.full_name, role=m.role, is_active=u.is_active,
                       totp_enabled=u.totp_enabled, last_login_at=u.last_login_at, created_at=m.created_at)
             for m, u in rows]
    return Page(items=items, total=total or 0, page=p.page, page_size=p.page_size)


@router.post("/users", response_model=MemberOut, status_code=201)
async def add_member(body: MemberCreate, ctx: Ctx = Depends(require(Permission.USERS_MANAGE)),
                     db: AsyncSession = Depends(get_db)):
    _check_role_assignable(ctx, body.role)
    user = await db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    if user is None:
        if not body.password:
            raise ValidationFailed("password is required for a new user")
        problems = validate_password_strength(body.password)
        if problems:
            raise ValidationFailed("password " + ", ".join(problems))
        user = User(email=body.email.lower(), full_name=body.full_name, password_hash=hash_password(body.password))
        db.add(user)
        await db.flush()
    elif await db.scalar(select(Membership.id).where(Membership.user_id == user.id,
                                                      Membership.organization_id == ctx.org_id)):
        raise Conflict("user is already a member of this organization")
    m = Membership(user_id=user.id, organization_id=ctx.org_id, role=body.role)
    db.add(m)
    audit.record(db, action="user.added", ctx=ctx, target_type="user", target_id=user.id,
                 details={"email": user.email, "role": body.role})
    await db.commit()
    return MemberOut(user_id=user.id, email=user.email, full_name=user.full_name, role=m.role, is_active=user.is_active,
                     totp_enabled=user.totp_enabled, last_login_at=user.last_login_at, created_at=m.created_at)


async def _membership(db: AsyncSession, ctx: Ctx, user_id: uuid.UUID) -> tuple[Membership, User]:
    row = (await db.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(
        Membership.organization_id == ctx.org_id, Membership.user_id == user_id))).first()
    if not row:
        raise NotFound("User")
    return row[0], row[1]


async def _ensure_not_last_admin(db: AsyncSession, ctx: Ctx, m: Membership) -> None:
    if m.role != Role.ORG_ADMIN:
        return
    admins = await db.scalar(select(func.count()).select_from(Membership).where(
        Membership.organization_id == ctx.org_id, Membership.role == Role.ORG_ADMIN))
    if (admins or 0) <= 1:
        raise ValidationFailed("the organization must keep at least one Organization Administrator")


@router.patch("/users/{user_id}", response_model=MemberOut)
async def update_member(user_id: uuid.UUID, body: MemberUpdate, ctx: Ctx = Depends(require(Permission.USERS_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    m, u = await _membership(db, ctx, user_id)
    if ctx.role != Role.SUPER_ADMIN and ROLE_RANK.get(Role(m.role), 0) > ROLE_RANK[ctx.role]:
        raise Forbidden("cannot modify a user with a higher role")
    changes: dict[str, Any] = {}
    if body.role is not None and body.role != m.role:
        _check_role_assignable(ctx, body.role)
        await _ensure_not_last_admin(db, ctx, m)
        changes["role"] = {"from": m.role, "to": body.role}
        m.role = body.role
    if body.is_active is not None and body.is_active != u.is_active:
        if u.id == ctx.user_id:
            raise ValidationFailed("you cannot deactivate yourself")
        if u.is_superadmin and ctx.role != Role.SUPER_ADMIN:
            raise Forbidden()
        u.is_active = body.is_active
        changes["is_active"] = body.is_active
        if not body.is_active:
            from app.services.auth import revoke_all_sessions

            await revoke_all_sessions(db, u.id)
    if body.full_name is not None:
        u.full_name = body.full_name
    audit.record(db, action="user.updated", ctx=ctx, target_type="user", target_id=u.id, details=changes)
    await db.commit()
    return MemberOut(user_id=u.id, email=u.email, full_name=u.full_name, role=m.role, is_active=u.is_active,
                     totp_enabled=u.totp_enabled, last_login_at=u.last_login_at, created_at=m.created_at)


@router.delete("/users/{user_id}", response_model=Message)
async def remove_member(user_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.USERS_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    m, u = await _membership(db, ctx, user_id)
    if u.id == ctx.user_id:
        raise ValidationFailed("you cannot remove yourself")
    if ctx.role != Role.SUPER_ADMIN and ROLE_RANK.get(Role(m.role), 0) > ROLE_RANK[ctx.role]:
        raise Forbidden("cannot remove a user with a higher role")
    await _ensure_not_last_admin(db, ctx, m)
    await db.delete(m)
    audit.record(db, action="user.removed", ctx=ctx, target_type="user", target_id=u.id, details={"email": u.email})
    await db.commit()
    return Message(message="User removed from organization")


# ---------------------------------------------------------------- teams

class TeamOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    member_ids: list[uuid.UUID]
    created_at: datetime


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)


async def _validate_member_ids(db: AsyncSession, ctx: Ctx, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    if not ids:
        return []
    valid = set((await db.scalars(select(Membership.user_id).where(
        Membership.organization_id == ctx.org_id, Membership.user_id.in_(ids)))).all())
    missing = set(ids) - valid
    if missing:
        raise ValidationFailed("some users are not members of this organization")
    return list(dict.fromkeys(ids))


@router.get("/teams", response_model=list[TeamOut])
async def list_teams(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    return (await db.scalars(select(Team).where(Team.organization_id == ctx.org_id).order_by(Team.name))).all()


@router.post("/teams", response_model=TeamOut, status_code=201)
async def create_team(body: TeamIn, ctx: Ctx = Depends(require(Permission.USERS_MANAGE)),
                      db: AsyncSession = Depends(get_db)):
    if await db.scalar(select(Team.id).where(Team.organization_id == ctx.org_id, Team.name == body.name)):
        raise Conflict("a team with this name already exists")
    team = Team(organization_id=ctx.org_id, name=body.name, description=body.description,
                member_ids=await _validate_member_ids(db, ctx, body.member_ids))
    db.add(team)
    audit.record(db, action="team.created", ctx=ctx, target_type="team", details={"name": body.name})
    await db.commit()
    return team


@router.put("/teams/{team_id}", response_model=TeamOut)
async def update_team(team_id: uuid.UUID, body: TeamIn, ctx: Ctx = Depends(require(Permission.USERS_MANAGE)),
                      db: AsyncSession = Depends(get_db)):
    team = await db.scalar(select(Team).where(Team.id == team_id, Team.organization_id == ctx.org_id))
    if not team:
        raise NotFound("Team")
    team.name, team.description = body.name, body.description
    team.member_ids = await _validate_member_ids(db, ctx, body.member_ids)
    audit.record(db, action="team.updated", ctx=ctx, target_type="team", target_id=team.id)
    await db.commit()
    return team


@router.delete("/teams/{team_id}", response_model=Message)
async def delete_team(team_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.USERS_MANAGE)),
                      db: AsyncSession = Depends(get_db)):
    team = await db.scalar(select(Team).where(Team.id == team_id, Team.organization_id == ctx.org_id))
    if not team:
        raise NotFound("Team")
    await db.delete(team)
    audit.record(db, action="team.deleted", ctx=ctx, target_type="team", target_id=team_id, details={"name": team.name})
    await db.commit()
    return Message(message="Team deleted")


# ---------------------------------------------------------------- API keys

class ApiKeyOut(ORM):
    id: uuid.UUID
    name: str
    prefix: str
    role: str
    scopes: list[str]
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None


class ApiKeyCreated(ApiKeyOut):
    key: str  # shown once


class ApiKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: Role = Role.VIEWER
    scopes: list[str] = Field(default_factory=list)
    expires_at: datetime | None = None


@router.get("/api-keys", response_model=list[ApiKeyOut])
async def list_keys(ctx: Ctx = Depends(require(Permission.API_KEYS_MANAGE)), db: AsyncSession = Depends(get_db)):
    return (await db.scalars(select(ApiKey).where(ApiKey.organization_id == ctx.org_id)
                             .order_by(ApiKey.created_at.desc()))).all()


@router.post("/api-keys", response_model=ApiKeyCreated, status_code=201)
async def create_key(body: ApiKeyIn, ctx: Ctx = Depends(require(Permission.API_KEYS_MANAGE)),
                     db: AsyncSession = Depends(get_db)):
    _check_role_assignable(ctx, body.role)
    bad = set(body.scopes) - API_KEY_SCOPES
    if bad:
        raise ValidationFailed(f"unknown scopes: {', '.join(sorted(bad))}")
    if ctx.principal.api_key:
        raise Forbidden("API keys cannot create API keys")
    full, prefix, secret_hash = generate_api_key()
    key = ApiKey(organization_id=ctx.org_id, name=body.name, prefix=prefix, secret_hash=secret_hash, role=body.role,
                 scopes=body.scopes, created_by_id=ctx.user_id, expires_at=body.expires_at)
    db.add(key)
    await db.flush()
    audit.record(db, action="api_key.created", ctx=ctx, target_type="api_key", target_id=key.id,
                 details={"name": body.name, "role": body.role, "scopes": body.scopes})
    await db.commit()
    out = ApiKeyCreated.model_validate({**ApiKeyOut.model_validate(key).model_dump(), "key": full})
    return out


@router.delete("/api-keys/{key_id}", response_model=Message)
async def revoke_key(key_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.API_KEYS_MANAGE)),
                     db: AsyncSession = Depends(get_db)):
    key = await db.scalar(select(ApiKey).where(ApiKey.id == key_id, ApiKey.organization_id == ctx.org_id))
    if not key:
        raise NotFound("API key")
    from app.services.auth import now_utc

    key.revoked_at = now_utc()
    audit.record(db, action="api_key.revoked", ctx=ctx, target_type="api_key", target_id=key.id, details={"name": key.name})
    await db.commit()
    return Message(message="API key revoked")


# ---------------------------------------------------------------- audit logs

class AuditOut(ORM):
    id: uuid.UUID
    actor_label: str
    actor_user_id: uuid.UUID | None
    action: str
    target_type: str
    target_id: str
    details: dict[str, Any]
    ip_address: str
    request_id: str
    created_at: datetime


@router.get("/audit-logs", response_model=Page[AuditOut])
async def list_audit(ctx: Ctx = Depends(require(Permission.AUDIT_READ)), db: AsyncSession = Depends(get_db),
                     p: PageParams = Depends(), action: str | None = Query(default=None, max_length=100),
                     actor: str | None = Query(default=None, max_length=320),
                     start: datetime | None = None, end: datetime | None = None):
    stmt = select(AuditLog).where(AuditLog.organization_id == ctx.org_id)
    if action:
        stmt = stmt.where(AuditLog.action.like(f"{action}%"))
    if actor:
        stmt = stmt.where(func.lower(AuditLog.actor_label).like(f"%{actor.lower()}%"))
    if start:
        stmt = stmt.where(AuditLog.created_at >= start)
    if end:
        stmt = stmt.where(AuditLog.created_at < end)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.scalars(stmt.order_by(AuditLog.created_at.desc()).offset(p.offset).limit(p.page_size))).all()
    return Page(items=[AuditOut.model_validate(r) for r in rows], total=total or 0, page=p.page, page_size=p.page_size)
