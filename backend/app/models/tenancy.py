from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, utcnow


def default_org_settings() -> dict[str, Any]:
    return {
        "session_idle_minutes": 120,
        "reopen_window_minutes": 60,
        "agent_timeout_seconds": 180,
        "ssl_alert_days": [30, 14, 7, 3, 0],
        "log_retention_days": 14,
        "metric_retention_days": 90,
        "logs_per_day_quota": 5_000_000,
        "unreachable_after_failures": 3,
        "metric_consecutive_samples": 2,
    }


def default_thresholds() -> dict[str, Any]:
    # metric -> {warning, critical}; values are percentages unless noted.
    return {
        "cpu_percent": {"warning": 80, "critical": 95},
        "memory_percent": {"warning": 85, "critical": 95},
        "disk_percent": {"warning": 80, "critical": 90},
        "load_per_core": {"warning": 2.0, "critical": 4.0},
    }


class Organization(UUIDPk, Timestamps, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    settings: Mapped[dict[str, Any]] = mapped_column(default=default_org_settings)
    thresholds: Mapped[dict[str, Any]] = mapped_column(default=default_thresholds)
    # Authorised monitoring scope: {"cidrs": [...], "hostnames": [".example.com", "api.x.io"]}
    monitoring_scope: Mapped[dict[str, Any]] = mapped_column(default=lambda: {"cidrs": [], "hostnames": []})
    incident_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class User(UUIDPk, Timestamps, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320))
    full_name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superadmin: Mapped[bool] = mapped_column(Boolean, default=False)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    totp_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login_at: Mapped[datetime | None] = mapped_column(nullable=True)
    password_changed_at: Mapped[datetime] = mapped_column(default=utcnow)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(nullable=True)
    telegram_chat_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    memberships: Mapped[list[Membership]] = relationship(back_populates="user", cascade="all, delete-orphan",
                                                          lazy="raise_on_sql", passive_deletes=True)

    __table_args__ = (Index("uq_users_email_lower", func.lower(email), unique=True),)


class Membership(UUIDPk, Timestamps, Base):
    __tablename__ = "memberships"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32))

    user: Mapped[User] = relationship(back_populates="memberships", lazy="raise_on_sql")
    organization: Mapped[Organization] = relationship(lazy="raise_on_sql")

    __table_args__ = (UniqueConstraint("user_id", "organization_id", name="uq_memberships_user_org"),)


class Team(UUIDPk, Timestamps, Base):
    __tablename__ = "teams"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    member_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), default=list)

    __table_args__ = (UniqueConstraint("organization_id", "name", name="uq_teams_org_name"),)


class UserSession(UUIDPk, Base):
    __tablename__ = "user_sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    family_id: Mapped[uuid.UUID] = mapped_column(index=True)
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
    rotated_at: Mapped[datetime | None] = mapped_column(nullable=True)
    user_agent: Mapped[str] = mapped_column(String(400), default="")
    ip_address: Mapped[str] = mapped_column(String(64), default="")


class PasswordResetToken(UUIDPk, Base):
    __tablename__ = "password_reset_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None] = mapped_column(nullable=True)


class ApiKey(UUIDPk, Timestamps, Base):
    __tablename__ = "api_keys"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    prefix: Mapped[str] = mapped_column(String(16), unique=True)
    secret_hash: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32))
    scopes: Mapped[list[str]] = mapped_column(ARRAY(String(64)), default=list)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)


class AuditLog(UUIDPk, Base):
    __tablename__ = "audit_logs"

    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    actor_api_key_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    actor_label: Mapped[str] = mapped_column(String(320), default="")
    action: Mapped[str] = mapped_column(String(100))
    target_type: Mapped[str] = mapped_column(String(64), default="")
    target_id: Mapped[str] = mapped_column(String(64), default="")
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    ip_address: Mapped[str] = mapped_column(String(64), default="")
    request_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)

    __table_args__ = (Index("ix_audit_logs_org_created", "organization_id", "created_at"),)


class SavedSearch(UUIDPk, Timestamps, Base):
    __tablename__ = "saved_searches"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(32), default="logs")  # logs | resources | incidents
    query: Mapped[dict[str, Any]] = mapped_column(default=dict)
    shared: Mapped[bool] = mapped_column(Boolean, default=False)
