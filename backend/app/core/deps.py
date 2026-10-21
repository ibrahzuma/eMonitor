"""Request authentication and tenant context resolution.

Every tenant-scoped endpoint depends on `require(Permission.X)` which yields a `Ctx` holding the
authenticated principal, the active organization and the effective permission set. Data access
code takes `ctx.org_id` from here — never from request bodies.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.errors import Forbidden, NotFound, Unauthorized
from app.core.permissions import Permission, permissions_for
from app.core.ratelimit import client_ip
from app.core.security import constant_time_equals, decode_token, parse_api_key, sha256_hex
from app.models import ApiKey, Membership, Organization, User, UserSession
from app.models.enums import Role


@dataclass
class Principal:
    user: User | None = None
    api_key: ApiKey | None = None
    session_id: uuid.UUID | None = None

    @property
    def is_superadmin(self) -> bool:
        return bool(self.user and self.user.is_superadmin)

    @property
    def label(self) -> str:
        if self.user:
            return self.user.email
        if self.api_key:
            return f"api-key:{self.api_key.name}"
        return "anonymous"


@dataclass
class Ctx:
    principal: Principal
    org: Organization
    role: Role
    permissions: frozenset[Permission]
    ip: str = ""
    request_id: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def org_id(self) -> uuid.UUID:
        return self.org.id

    @property
    def user(self) -> User | None:
        return self.principal.user

    @property
    def user_id(self) -> uuid.UUID | None:
        return self.principal.user.id if self.principal.user else None

    def can(self, perm: Permission) -> bool:
        return perm in self.permissions

    def require(self, perm: Permission) -> None:
        if perm not in self.permissions:
            raise Forbidden()


def _extract_bearer(authorization: str | None, x_api_key: str | None) -> str | None:
    if x_api_key:
        return x_api_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def authenticate_token(db: AsyncSession, token: str) -> Principal:
    now = datetime.now(UTC)
    if token.startswith("emk_"):
        parsed = parse_api_key(token)
        if not parsed:
            raise Unauthorized("Invalid API key")
        prefix, secret = parsed
        key = await db.scalar(select(ApiKey).where(ApiKey.prefix == prefix))
        if (
            not key
            or key.revoked_at is not None
            or (key.expires_at is not None and key.expires_at <= now)
            or not constant_time_equals(key.secret_hash, sha256_hex(secret))
        ):
            raise Unauthorized("Invalid API key")
        if key.last_used_at is None or (now - key.last_used_at).total_seconds() > 60:
            key.last_used_at = now
            await db.commit()
        return Principal(api_key=key)

    payload = decode_token(token, "access")
    if not payload:
        raise Unauthorized("Invalid or expired token")
    try:
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (KeyError, ValueError):
        raise Unauthorized("Invalid token") from None
    session = await db.get(UserSession, session_id)
    if not session or session.revoked_at is not None or session.user_id != user_id or session.expires_at <= now:
        raise Unauthorized("Session expired")
    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise Unauthorized("Account disabled")
    return Principal(user=user, session_id=session_id)


async def get_principal(
    request: Request,
    db: AsyncSession = Depends(get_db),
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
) -> Principal:
    token = _extract_bearer(authorization, x_api_key)
    if not token:
        raise Unauthorized()
    principal = await authenticate_token(db, token)
    request.state.principal = principal
    return principal


async def get_user_principal(principal: Principal = Depends(get_principal)) -> Principal:
    """Endpoints that only make sense for interactive users (profile, 2FA)."""
    if not principal.user:
        raise Forbidden("This endpoint requires a user session")
    return principal


async def resolve_ctx(
    db: AsyncSession, principal: Principal, org_header: str | None, ip: str = "", request_id: str = ""
) -> Ctx:
    if principal.api_key:
        org = await db.get(Organization, principal.api_key.organization_id)
        if not org or not org.is_active:
            raise Unauthorized("Organization disabled")
        if org_header and org_header != str(org.id):
            raise Forbidden("API key is not valid for this organization")
        role = Role(principal.api_key.role)
        return Ctx(principal, org, role, permissions_for(role, principal.api_key.scopes), ip, request_id)

    user = principal.user
    assert user is not None
    org_id: uuid.UUID | None = None
    if org_header:
        try:
            org_id = uuid.UUID(org_header)
        except ValueError:
            raise NotFound("Organization") from None

    if user.is_superadmin:
        if org_id is None:
            first = await db.scalar(
                select(Membership.organization_id).where(Membership.user_id == user.id).limit(1)
            ) or await db.scalar(select(Organization.id).order_by(Organization.created_at).limit(1))
            org_id = first
        org = await db.get(Organization, org_id) if org_id else None
        if not org:
            raise NotFound("Organization")
        return Ctx(principal, org, Role.SUPER_ADMIN, permissions_for(Role.SUPER_ADMIN), ip, request_id)

    stmt = select(Membership).where(Membership.user_id == user.id)
    if org_id:
        stmt = stmt.where(Membership.organization_id == org_id)
    membership = await db.scalar(stmt.order_by(Membership.created_at).limit(1))
    if not membership:
        # Do not disclose whether the organization exists.
        raise NotFound("Organization")
    org = await db.get(Organization, membership.organization_id)
    if not org or not org.is_active:
        raise NotFound("Organization")
    role = Role(membership.role)
    return Ctx(principal, org, role, permissions_for(role), ip, request_id)


async def get_ctx(
    request: Request,
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
    x_organization_id: str | None = Header(default=None),
) -> Ctx:
    ctx = await resolve_ctx(
        db, principal, x_organization_id, client_ip(request), getattr(request.state, "request_id", "")
    )
    request.state.ctx = ctx
    return ctx


def require(*perms: Permission):
    """Dependency factory enforcing permissions in the active organization."""

    async def _dep(ctx: Ctx = Depends(get_ctx)) -> Ctx:
        for p in perms:
            ctx.require(p)
        return ctx

    return _dep


async def require_superadmin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_superadmin:
        raise Forbidden("Super Administrator privileges required")
    return principal
