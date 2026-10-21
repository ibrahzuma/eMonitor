from __future__ import annotations

import asyncio
import uuid
from datetime import datetime

import pyotp
from fastapi import APIRouter, Cookie, Depends, Header, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import Principal, get_user_principal
from app.core.errors import Forbidden, NotFound, Unauthorized, ValidationFailed
from app.core.permissions import permissions_for
from app.core.ratelimit import client_ip, limiter
from app.core.security import (
    constant_time_equals,
    create_mfa_token,
    decode_token,
    encrypt_str,
    hash_password,
    random_token,
    validate_password_strength,
    verify_password,
)
from app.models import Membership, Organization, User, UserSession
from app.models.enums import Role
from app.schemas.common import ORM, Message
from app.services import audit
from app.services import auth as svc

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "emonitor_refresh"
CSRF_COOKIE = "emonitor_csrf"


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


class MfaIn(BaseModel):
    mfa_token: str
    code: str = Field(min_length=6, max_length=10)


class OrgMembershipOut(BaseModel):
    organization_id: uuid.UUID
    organization_name: str
    organization_slug: str
    role: str


class UserOut(ORM):
    id: uuid.UUID
    email: str
    full_name: str
    timezone: str
    is_superadmin: bool
    totp_enabled: bool
    telegram_chat_id: str | None = None
    last_login_at: datetime | None = None


class MeOut(BaseModel):
    user: UserOut
    memberships: list[OrgMembershipOut]
    permissions: dict[str, list[str]]  # org_id → permissions


class TokenOut(BaseModel):
    access_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None
    mfa_required: bool = False
    mfa_token: str | None = None
    user: UserOut | None = None


def _set_cookies(response: Response, refresh: str) -> None:
    s = get_settings()
    max_age = s.refresh_token_days * 86400
    response.set_cookie(REFRESH_COOKIE, refresh, max_age=max_age, httponly=True, secure=s.cookie_secure,
                        samesite="strict", path=f"{s.api_prefix}/auth")
    response.set_cookie(CSRF_COOKIE, random_token(16), max_age=max_age, httponly=False, secure=s.cookie_secure,
                        samesite="strict", path="/")


def _clear_cookies(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(REFRESH_COOKIE, path=f"{s.api_prefix}/auth")
    response.delete_cookie(CSRF_COOKIE, path="/")


def _check_csrf(csrf_cookie: str | None, csrf_header: str | None) -> None:
    if not csrf_cookie or not csrf_header or not constant_time_equals(csrf_cookie, csrf_header):
        raise Forbidden("CSRF validation failed")


async def _token_response(db: AsyncSession, response: Response, user: User, refresh: str, access: str) -> TokenOut:
    _set_cookies(response, refresh)
    return TokenOut(access_token=access, expires_in=get_settings().access_token_minutes * 60,
                    user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenOut, dependencies=[Depends(limiter("login", "rate_limit_login"))])
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> TokenOut:
    user = await svc.check_credentials(db, body.email, body.password)
    if user.totp_enabled:
        await db.commit()
        return TokenOut(mfa_required=True, mfa_token=create_mfa_token(user.id))
    sess, refresh, access = await svc.login_success(db, user, request.headers.get("user-agent", ""), client_ip(request))
    audit.record(db, action="auth.login", principal=Principal(user=user), target_type="user", target_id=user.id,
                 ip=client_ip(request), request_id=getattr(request.state, "request_id", ""))
    await db.commit()
    return await _token_response(db, response, user, refresh, access)


@router.post("/login/mfa", response_model=TokenOut, dependencies=[Depends(limiter("mfa", "rate_limit_login"))])
async def login_mfa(body: MfaIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> TokenOut:
    payload = decode_token(body.mfa_token, "mfa")
    if not payload:
        raise Unauthorized("MFA session expired; log in again")
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active or not user.totp_enabled or not svc.verify_totp(user, body.code):
        raise Unauthorized("Invalid verification code")
    sess, refresh, access = await svc.login_success(db, user, request.headers.get("user-agent", ""), client_ip(request))
    audit.record(db, action="auth.login", principal=Principal(user=user), target_type="user", target_id=user.id,
                 details={"mfa": True}, ip=client_ip(request))
    await db.commit()
    return await _token_response(db, response, user, refresh, access)


@router.post("/refresh", response_model=TokenOut, dependencies=[Depends(limiter("refresh", "rate_limit_sensitive"))])
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db),
                  emonitor_refresh: str | None = Cookie(default=None), emonitor_csrf: str | None = Cookie(default=None),
                  x_csrf_token: str | None = Header(default=None)) -> TokenOut:
    _check_csrf(emonitor_csrf, x_csrf_token)
    if not emonitor_refresh:
        raise Unauthorized("No session")
    try:
        user, sess, new_refresh, access = await svc.rotate_refresh(
            db, emonitor_refresh, request.headers.get("user-agent", ""), client_ip(request))
    except Unauthorized:
        _clear_cookies(response)
        raise
    await db.commit()
    return await _token_response(db, response, user, new_refresh, access)


@router.post("/logout", response_model=Message)
async def logout(response: Response, db: AsyncSession = Depends(get_db),
                 emonitor_refresh: str | None = Cookie(default=None), emonitor_csrf: str | None = Cookie(default=None),
                 x_csrf_token: str | None = Header(default=None)) -> Message:
    _check_csrf(emonitor_csrf, x_csrf_token)
    if emonitor_refresh:
        from app.core.security import sha256_hex

        sess = await db.scalar(select(UserSession).where(UserSession.refresh_hash == sha256_hex(emonitor_refresh)))
        if sess:
            await svc.revoke_family(db, sess.id)
            await db.commit()
    _clear_cookies(response)
    return Message(message="Logged out")


async def build_me(db: AsyncSession, user: User) -> MeOut:
    if user.is_superadmin:
        orgs = (await db.scalars(select(Organization).where(Organization.is_active.is_(True))
                                 .order_by(Organization.name))).all()
        memberships = [OrgMembershipOut(organization_id=o.id, organization_name=o.name, organization_slug=o.slug,
                                        role=Role.SUPER_ADMIN) for o in orgs]
    else:
        rows = (await db.execute(
            select(Membership, Organization).join(Organization, Organization.id == Membership.organization_id)
            .where(Membership.user_id == user.id, Organization.is_active.is_(True)).order_by(Organization.name)
        )).all()
        memberships = [OrgMembershipOut(organization_id=o.id, organization_name=o.name, organization_slug=o.slug,
                                        role=m.role) for m, o in rows]
    perms = {str(m.organization_id): sorted(p.value for p in permissions_for(m.role)) for m in memberships}
    return MeOut(user=UserOut.model_validate(user), memberships=memberships, permissions=perms)


@router.get("/me", response_model=MeOut)
async def me(principal: Principal = Depends(get_user_principal), db: AsyncSession = Depends(get_db)) -> MeOut:
    assert principal.user
    return await build_me(db, principal.user)


class ProfileIn(BaseModel):
    full_name: str | None = Field(default=None, max_length=200)
    timezone: str | None = Field(default=None, max_length=64)
    telegram_chat_id: str | None = Field(default=None, max_length=64)


@router.patch("/me", response_model=UserOut)
async def update_me(body: ProfileIn, principal: Principal = Depends(get_user_principal),
                    db: AsyncSession = Depends(get_db)) -> UserOut:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    user = await db.get(User, principal.user.id)  # type: ignore[union-attr]
    assert user
    data = body.model_dump(exclude_unset=True)
    if "timezone" in data and data["timezone"]:
        try:
            ZoneInfo(data["timezone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise ValidationFailed("unknown time zone") from None
    for k, v in data.items():
        if v is not None:
            setattr(user, k, v)
    await db.commit()
    return UserOut.model_validate(user)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(max_length=1024)


@router.post("/change-password", response_model=Message, dependencies=[Depends(limiter("pwchange", "rate_limit_sensitive"))])
async def change_password(body: ChangePasswordIn, request: Request, principal: Principal = Depends(get_user_principal),
                          db: AsyncSession = Depends(get_db)) -> Message:
    user = await db.get(User, principal.user.id)  # type: ignore[union-attr]
    assert user
    if not verify_password(body.current_password, user.password_hash):
        raise ValidationFailed("current password is incorrect")
    problems = validate_password_strength(body.new_password)
    if problems:
        raise ValidationFailed("password " + ", ".join(problems))
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = svc.now_utc()
    current = await db.get(UserSession, principal.session_id) if principal.session_id else None
    await svc.revoke_all_sessions(db, user.id, except_family=current.family_id if current else None)
    audit.record(db, action="auth.password_changed", principal=principal, target_type="user", target_id=user.id,
                 ip=client_ip(request))
    await db.commit()
    return Message(message="Password changed; other sessions were signed out")


class ForgotIn(BaseModel):
    email: EmailStr


@router.post("/forgot-password", response_model=Message, status_code=202,
             dependencies=[Depends(limiter("forgot", "rate_limit_sensitive"))])
async def forgot_password(body: ForgotIn, db: AsyncSession = Depends(get_db)) -> Message:
    user = await svc.find_user_by_email(db, body.email)
    if user and user.is_active:
        token = await svc.create_reset_token(db, user)
        await db.commit()
        asyncio.get_running_loop().run_in_executor(None, svc.send_reset_email, user.email, token)
    # Identical response whether or not the account exists.
    return Message(message="If the address is registered, a reset link has been sent")


class ResetIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(max_length=1024)


@router.post("/reset-password", response_model=Message, dependencies=[Depends(limiter("reset", "rate_limit_sensitive"))])
async def reset_password(body: ResetIn, request: Request, db: AsyncSession = Depends(get_db)) -> Message:
    problems = validate_password_strength(body.new_password)
    if problems:
        raise ValidationFailed("password " + ", ".join(problems))
    user = await svc.consume_reset_token(db, body.token)
    if not user:
        raise ValidationFailed("reset link is invalid or has expired")
    user.password_hash = hash_password(body.new_password)
    user.password_changed_at = svc.now_utc()
    user.failed_login_count = 0
    user.locked_until = None
    await svc.revoke_all_sessions(db, user.id)
    audit.record(db, action="auth.password_reset", principal=Principal(user=user), target_type="user", target_id=user.id,
                 ip=client_ip(request))
    await db.commit()
    return Message(message="Password updated; please log in")


class TotpSetupOut(BaseModel):
    secret: str
    otpauth_url: str


@router.post("/2fa/setup", response_model=TotpSetupOut)
async def totp_setup(principal: Principal = Depends(get_user_principal), db: AsyncSession = Depends(get_db)) -> TotpSetupOut:
    user = await db.get(User, principal.user.id)  # type: ignore[union-attr]
    assert user
    if user.totp_enabled:
        raise ValidationFailed("two-factor authentication is already enabled")
    secret = pyotp.random_base32()
    user.totp_secret_enc = encrypt_str(secret)
    await db.commit()
    url = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=get_settings().app_name)
    return TotpSetupOut(secret=secret, otpauth_url=url)


class TotpCodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)
    password: str | None = None


@router.post("/2fa/enable", response_model=Message, dependencies=[Depends(limiter("2fa", "rate_limit_sensitive"))])
async def totp_enable(body: TotpCodeIn, request: Request, principal: Principal = Depends(get_user_principal),
                      db: AsyncSession = Depends(get_db)) -> Message:
    user = await db.get(User, principal.user.id)  # type: ignore[union-attr]
    assert user
    if not user.totp_secret_enc or not svc.verify_totp(user, body.code):
        raise ValidationFailed("invalid verification code")
    user.totp_enabled = True
    audit.record(db, action="auth.2fa_enabled", principal=principal, target_type="user", target_id=user.id,
                 ip=client_ip(request))
    await db.commit()
    return Message(message="Two-factor authentication enabled")


@router.post("/2fa/disable", response_model=Message, dependencies=[Depends(limiter("2fa", "rate_limit_sensitive"))])
async def totp_disable(body: TotpCodeIn, request: Request, principal: Principal = Depends(get_user_principal),
                       db: AsyncSession = Depends(get_db)) -> Message:
    user = await db.get(User, principal.user.id)  # type: ignore[union-attr]
    assert user
    if not user.totp_enabled:
        raise ValidationFailed("two-factor authentication is not enabled")
    if not body.password or not verify_password(body.password, user.password_hash) or not svc.verify_totp(user, body.code):
        raise ValidationFailed("password or verification code is incorrect")
    user.totp_enabled = False
    user.totp_secret_enc = None
    audit.record(db, action="auth.2fa_disabled", principal=principal, target_type="user", target_id=user.id,
                 ip=client_ip(request))
    await db.commit()
    return Message(message="Two-factor authentication disabled")


class SessionOut(ORM):
    id: uuid.UUID
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime
    user_agent: str
    ip_address: str
    current: bool = False


@router.get("/sessions", response_model=list[SessionOut])
async def list_sessions(principal: Principal = Depends(get_user_principal), db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(UserSession).where(
        UserSession.user_id == principal.user.id, UserSession.revoked_at.is_(None),  # type: ignore[union-attr]
        UserSession.rotated_at.is_(None), UserSession.expires_at > svc.now_utc(),
    ).order_by(UserSession.last_used_at.desc()))).all()
    current = await db.get(UserSession, principal.session_id) if principal.session_id else None
    out = []
    for r in rows:
        item = SessionOut.model_validate(r)
        item.current = bool(current and r.family_id == current.family_id)
        out.append(item)
    return out


@router.delete("/sessions/{session_id}", response_model=Message)
async def revoke_session(session_id: uuid.UUID, principal: Principal = Depends(get_user_principal),
                         db: AsyncSession = Depends(get_db)) -> Message:
    sess = await db.get(UserSession, session_id)
    if not sess or sess.user_id != principal.user.id:  # type: ignore[union-attr]
        raise NotFound("Session")
    await svc.revoke_family(db, sess.id)
    await db.commit()
    return Message(message="Session revoked")
