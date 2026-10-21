"""Authentication flows: login, refresh rotation with reuse detection, password reset, TOTP."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pyotp
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Unauthorized
from app.core.security import (
    create_access_token,
    decrypt_str,
    hash_password,
    password_needs_rehash,
    random_token,
    sha256_hex,
    verify_password,
)
from app.models import Membership, Organization, PasswordResetToken, User, UserSession

log = logging.getLogger("emonitor.auth")
MAX_FAILED_LOGINS = 10
LOCKOUT_MINUTES = 15
REUSE_GRACE_SECONDS = 5


def now_utc() -> datetime:
    return datetime.now(UTC)


async def find_user_by_email(db: AsyncSession, email: str) -> User | None:
    return await db.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))


async def check_credentials(db: AsyncSession, email: str, password: str) -> User:
    user = await find_user_by_email(db, email)
    now = now_utc()
    if user and user.locked_until and user.locked_until > now:
        await asyncio.to_thread(verify_password, password, None)  # equalize timing
        raise Unauthorized("Account temporarily locked due to repeated failed logins")
    # Argon2 is deliberately CPU-heavy: run it off the event loop.
    ok = await asyncio.to_thread(verify_password, password, user.password_hash if user else None)
    if not user or not ok or not user.is_active:
        if user:
            user.failed_login_count += 1
            if user.failed_login_count >= MAX_FAILED_LOGINS:
                user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
                user.failed_login_count = 0
            await db.commit()
        raise Unauthorized("Invalid email or password")
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.failed_login_count = 0
    user.locked_until = None
    return user


def verify_totp(user: User, code: str) -> bool:
    if not user.totp_secret_enc:
        return False
    secret = decrypt_str(user.totp_secret_enc)
    return pyotp.TOTP(secret).verify(code.strip().replace(" ", ""), valid_window=1)


async def idle_minutes_for(db: AsyncSession, user: User) -> int:
    values = (await db.scalars(
        select(Organization.settings).join(Membership, Membership.organization_id == Organization.id)
        .where(Membership.user_id == user.id)
    )).all()
    mins = [int((v or {}).get("session_idle_minutes", 0) or 0) for v in values]
    mins = [m for m in mins if m > 0]
    return min(mins) if mins else get_settings().session_idle_minutes_default


async def create_session(db: AsyncSession, user: User, user_agent: str, ip: str,
                         family_id: uuid.UUID | None = None) -> tuple[UserSession, str, str]:
    s = get_settings()
    refresh = random_token(32)
    now = now_utc()
    sess = UserSession(
        user_id=user.id, family_id=family_id or uuid.uuid4(), refresh_hash=sha256_hex(refresh),
        created_at=now, last_used_at=now, expires_at=now + timedelta(days=s.refresh_token_days),
        user_agent=user_agent[:400], ip_address=ip[:64],
    )
    db.add(sess)
    await db.flush()
    return sess, refresh, create_access_token(user.id, sess.id)


async def login_success(db: AsyncSession, user: User, user_agent: str, ip: str) -> tuple[UserSession, str, str]:
    user.last_login_at = now_utc()
    return await create_session(db, user, user_agent, ip)


async def rotate_refresh(db: AsyncSession, refresh_token: str, user_agent: str, ip: str) -> tuple[User, UserSession, str, str]:
    now = now_utc()
    sess = await db.scalar(select(UserSession).where(UserSession.refresh_hash == sha256_hex(refresh_token))
                           .with_for_update())
    if not sess or sess.revoked_at is not None or sess.expires_at <= now:
        raise Unauthorized("Session expired")
    if sess.rotated_at is not None:
        if (now - sess.rotated_at).total_seconds() > REUSE_GRACE_SECONDS:
            # Refresh token reuse → likely theft. Revoke the whole session family.
            await db.execute(update(UserSession).where(UserSession.family_id == sess.family_id,
                                                       UserSession.revoked_at.is_(None)).values(revoked_at=now))
            await db.commit()
            log.warning("refresh token reuse detected; session family revoked", extra={"user_id": str(sess.user_id)})
        raise Unauthorized("Session expired")
    user = await db.get(User, sess.user_id)
    if not user or not user.is_active:
        raise Unauthorized("Account disabled")
    idle = await idle_minutes_for(db, user)
    if now - sess.last_used_at > timedelta(minutes=idle):
        sess.revoked_at = now
        await db.commit()
        raise Unauthorized("Session timed out due to inactivity")
    sess.rotated_at = now
    new_sess, refresh, access = await create_session(db, user, user_agent, ip, family_id=sess.family_id)
    new_sess.created_at = sess.created_at
    new_sess.expires_at = sess.expires_at  # absolute lifetime does not extend on rotation
    return user, new_sess, refresh, access


async def revoke_family(db: AsyncSession, session_id: uuid.UUID) -> None:
    sess = await db.get(UserSession, session_id)
    if sess:
        await db.execute(update(UserSession).where(UserSession.family_id == sess.family_id,
                                                   UserSession.revoked_at.is_(None)).values(revoked_at=now_utc()))


async def revoke_all_sessions(db: AsyncSession, user_id: uuid.UUID, except_family: uuid.UUID | None = None) -> None:
    stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_family:
        stmt = stmt.where(UserSession.family_id != except_family)
    await db.execute(stmt.values(revoked_at=now_utc()))


async def create_reset_token(db: AsyncSession, user: User) -> str:
    token = random_token(32)
    db.add(PasswordResetToken(user_id=user.id, token_hash=sha256_hex(token),
                              expires_at=now_utc() + timedelta(minutes=get_settings().password_reset_minutes)))
    return token


async def consume_reset_token(db: AsyncSession, token: str) -> User | None:
    now = now_utc()
    rec = await db.scalar(select(PasswordResetToken).where(PasswordResetToken.token_hash == sha256_hex(token))
                          .with_for_update())
    if not rec or rec.used_at is not None or rec.expires_at <= now:
        return None
    rec.used_at = now
    return await db.get(User, rec.user_id)


def send_reset_email(email: str, token: str) -> None:
    """Send the reset link via platform SMTP. Logged (without token) when SMTP is not configured."""
    import smtplib
    import ssl
    from email.message import EmailMessage

    s = get_settings()
    link = f"{s.public_base_url.rstrip('/')}/reset-password?token={token}"
    if not s.smtp_host:
        log.warning("password reset requested but SMTP is not configured; email not sent")
        return
    msg = EmailMessage()
    msg["Subject"] = f"{s.app_name}: password reset"
    msg["From"] = s.smtp_from
    msg["To"] = email
    msg.set_content(f"A password reset was requested for your account.\n\nReset link (valid "
                    f"{s.password_reset_minutes} minutes):\n{link}\n\nIf you did not request this, ignore this email.")
    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20) as server:
            if s.smtp_starttls:
                server.starttls(context=ssl.create_default_context())
            if s.smtp_username:
                server.login(s.smtp_username, s.smtp_password.get_secret_value() if s.smtp_password else "")
            server.send_message(msg)
    except Exception:
        log.exception("failed to send password reset email")
