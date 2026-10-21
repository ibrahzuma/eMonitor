"""Incidents, alert rules, notifications, maintenance windows and SLOs."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamps, UUIDPk, utcnow


class Incident(UUIDPk, Timestamps, Base):
    __tablename__ = "incidents"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    number: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="triggered")
    source: Mapped[str] = mapped_column(String(16))
    source_id: Mapped[str] = mapped_column(String(64), default="")
    dedup_key: Mapped[str] = mapped_column(String(300))
    resource_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("resources.id", ondelete="SET NULL"), nullable=True)
    team_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    alert_rule_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("alert_rules.id", ondelete="SET NULL"), nullable=True
    )
    trigger_condition: Mapped[str] = mapped_column(String(1000), default="")
    evidence: Mapped[dict[str, Any]] = mapped_column(default=dict)
    first_detected_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_detected_at: Mapped[datetime] = mapped_column(default=utcnow)
    acknowledged_at: Mapped[datetime | None] = mapped_column(nullable=True)
    acknowledged_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(nullable=True)
    resolved_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    resolution: Mapped[str] = mapped_column(Text, default="")
    auto_resolve: Mapped[bool] = mapped_column(Boolean, default=True)
    occurrence_count: Mapped[int] = mapped_column(Integer, default=1)
    reopen_count: Mapped[int] = mapped_column(Integer, default=0)
    in_maintenance: Mapped[bool] = mapped_column(Boolean, default=False)
    escalation_step: Mapped[int] = mapped_column(Integer, default=0)
    next_escalation_at: Mapped[datetime | None] = mapped_column(nullable=True)
    notification_policy_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("notification_policies.id", ondelete="SET NULL"), nullable=True
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    group_key: Mapped[str] = mapped_column(String(300), default="")  # related alerts grouping (e.g. resource)

    __table_args__ = (
        UniqueConstraint("organization_id", "number", name="uq_incidents_org_number"),
        # At most one open incident per condition — the core of deduplication.
        Index(
            "uq_incidents_open_dedup",
            "organization_id",
            "dedup_key",
            unique=True,
            postgresql_where=text("status <> 'resolved'"),
        ),
        Index("ix_incidents_org_status", "organization_id", "status"),
        Index("ix_incidents_org_created", "organization_id", "created_at"),
        Index("ix_incidents_dedup_resolved", "organization_id", "dedup_key", "resolved_at"),
        Index("ix_incidents_escalation", "next_escalation_at", postgresql_where=text("next_escalation_at IS NOT NULL")),
    )


class IncidentEvent(UUIDPk, Base):
    __tablename__ = "incident_events"

    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    message: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any]] = mapped_column(default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class AlertRule(UUIDPk, Timestamps, Base):
    __tablename__ = "alert_rules"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    rule_type: Mapped[str] = mapped_column(String(32))
    # {"resource_ids": [...], "group_ids": [...], "tags": [...], "kinds": [...], "check_ids": [...]}
    target: Mapped[dict[str, Any]] = mapped_column(default=dict)
    condition: Mapped[dict[str, Any]] = mapped_column(default=dict)
    severity: Mapped[str] = mapped_column(String(16), default="warning")
    evaluation_interval_seconds: Mapped[int] = mapped_column(Integer, default=60)
    consecutive_breaches: Mapped[int] = mapped_column(Integer, default=1)
    recovery_consecutive: Mapped[int] = mapped_column(Integer, default=1)
    cooldown_seconds: Mapped[int] = mapped_column(Integer, default=300)
    suppress_in_maintenance: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_resolve: Mapped[bool] = mapped_column(Boolean, default=True)
    notification_policy_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("notification_policies.id", ondelete="SET NULL"), nullable=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    next_eval_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_eval_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_error: Mapped[str] = mapped_column(String(1000), default="")


class AlertRuleState(Base):
    __tablename__ = "alert_rule_states"

    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("alert_rules.id", ondelete="CASCADE"), primary_key=True)
    subject_key: Mapped[str] = mapped_column(String(200), primary_key=True)  # resource id or "global"
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    state: Mapped[str] = mapped_column(String(16), default="ok")  # ok | pending | firing
    breaches: Mapped[int] = mapped_column(Integer, default=0)
    oks: Mapped[int] = mapped_column(Integer, default=0)
    last_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_fired_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_resolved_at: Mapped[datetime | None] = mapped_column(nullable=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)


class NotificationChannel(UUIDPk, Timestamps, Base):
    __tablename__ = "notification_channels"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(32))
    config: Mapped[dict[str, Any]] = mapped_column(default=dict)  # non-secret settings
    secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)  # encrypted JSON secrets
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    rate_limit_per_hour: Mapped[int] = mapped_column(Integer, default=60)
    last_test_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class NotificationPolicy(UUIDPk, Timestamps, Base):
    __tablename__ = "notification_policies"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    # Routing filter: policy applies when incident severity >= min_severity and team matches (if set)
    min_severity: Mapped[str] = mapped_column(String(16), default="info")
    team_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), default=list)
    # Escalation steps: [{"delay_minutes": 0, "channel_ids": [...]}, {"delay_minutes": 15, ...}]
    steps: Mapped[list[Any]] = mapped_column(default=list)
    notify_on_ack: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_on_resolve: Mapped[bool] = mapped_column(Boolean, default=True)
    # {"enabled": bool, "start": "22:00", "end": "07:00", "timezone": "Europe/Berlin", "allow_critical": true}
    quiet_hours: Mapped[dict[str, Any]] = mapped_column(default=dict)
    templates: Mapped[dict[str, Any]] = mapped_column(default=dict)  # {"subject": "...", "body": "..."}
    priority: Mapped[int] = mapped_column(Integer, default=100)  # lower = evaluated first
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class NotificationDelivery(UUIDPk, Base):
    __tablename__ = "notification_deliveries"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    incident_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), nullable=True)
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("notification_channels.id", ondelete="SET NULL"), nullable=True
    )
    channel_type: Mapped[str] = mapped_column(String(32))
    event: Mapped[str] = mapped_column(String(32))
    step: Mapped[int] = mapped_column(Integer, default=0)
    dedup_key: Mapped[str] = mapped_column(String(300), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    status_reason: Mapped[str] = mapped_column(String(300), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    next_attempt_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_error: Mapped[str] = mapped_column(String(1000), default="")
    subject: Mapped[str] = mapped_column(String(500), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    __table_args__ = (
        Index("ix_deliveries_org_created", "organization_id", "created_at"),
        Index("ix_deliveries_retry", "next_attempt_at", postgresql_where=text("status = 'pending'")),
    )


class InAppNotification(UUIDPk, Base):
    __tablename__ = "in_app_notifications"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    incident_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), nullable=True)
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[str] = mapped_column(String(16), default="info")
    read_at: Mapped[datetime | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    __table_args__ = (Index("ix_in_app_user_org", "user_id", "organization_id", "created_at"),)


class MaintenanceWindow(UUIDPk, Timestamps, Base):
    __tablename__ = "maintenance_windows"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    reason: Mapped[str] = mapped_column(Text, default="")
    starts_at: Mapped[datetime]  # first occurrence start (UTC)
    ends_at: Mapped[datetime]  # first occurrence end (UTC)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    # {"freq": "daily|weekly|monthly", "interval": 1, "byweekday": [0..6], "until": iso | null, "count": n | null}
    recurrence: Mapped[dict[str, Any] | None] = mapped_column(nullable=True)
    scope: Mapped[str] = mapped_column(String(16), default="resources")  # resources | groups | organization
    resource_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), default=list)
    group_ids: Mapped[list[uuid.UUID]] = mapped_column(ARRAY(Uuid), default=list)
    suppress_notifications: Mapped[bool] = mapped_column(Boolean, default=True)
    suppress_incidents: Mapped[bool] = mapped_column(Boolean, default=False)
    responsible_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Slo(UUIDPk, Timestamps, Base):
    __tablename__ = "slos"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"))
    check_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("checks.id", ondelete="CASCADE"), nullable=True)
    target_percent: Mapped[float] = mapped_column(Float, default=99.9)
    window_days: Mapped[int] = mapped_column(Integer, default=30)
    # Multi-window burn-rate alerting (Google SRE workbook style)
    burn_rate_alerts: Mapped[bool] = mapped_column(Boolean, default=True)
    fast_burn_threshold: Mapped[float] = mapped_column(Float, default=14.4)  # over 1h
    slow_burn_threshold: Mapped[float] = mapped_column(Float, default=6.0)  # over 6h
    notification_policy_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("notification_policies.id", ondelete="SET NULL"), nullable=True
    )
    last_evaluated_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_status: Mapped[dict[str, Any]] = mapped_column(default=dict)
