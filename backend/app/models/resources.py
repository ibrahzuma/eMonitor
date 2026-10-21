from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, Boolean, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, Timestamps, UUIDPk, utcnow


class ResourceGroup(UUIDPk, Timestamps, Base):
    """Folder-like grouping of resources. Groups may nest via parent_id."""

    __tablename__ = "resource_groups"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("resource_groups.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (UniqueConstraint("organization_id", "parent_id", "name", name="uq_resource_groups_org_parent_name"),)


class Resource(UUIDPk, Timestamps, Base):
    """Any monitored thing: server, website, API, network device, database, application, service."""

    __tablename__ = "resources"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    # Primary address: hostname / IP / URL, depending on kind (informational; checks carry targets).
    address: Mapped[str] = mapped_column(String(2048), default="")
    environment: Mapped[str] = mapped_column(String(32), default="production")
    location: Mapped[str] = mapped_column(String(200), default="")
    business_owner: Mapped[str] = mapped_column(String(200), default="")
    group_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("resource_groups.id", ondelete="SET NULL"), nullable=True)
    team_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String(64)), default=list)
    custom_fields: Mapped[dict[str, Any]] = mapped_column(default=dict)
    attributes: Mapped[dict[str, Any]] = mapped_column(default=dict)  # kind-specific non-secret metadata
    status: Mapped[str] = mapped_column(String(32), default="unknown")
    status_reason: Mapped[str] = mapped_column(String(500), default="")
    status_changed_at: Mapped[datetime] = mapped_column(default=utcnow)
    is_paused: Mapped[bool] = mapped_column(Boolean, default=False)

    server: Mapped[ServerDetail | None] = relationship(
        back_populates="resource", uselist=False, cascade="all, delete-orphan", lazy="raise_on_sql",
        passive_deletes=True,
    )
    checks: Mapped[list[Check]] = relationship(back_populates="resource", cascade="all, delete-orphan",
                                               lazy="raise_on_sql", passive_deletes=True)

    __table_args__ = (
        Index("ix_resources_org_kind", "organization_id", "kind"),
        Index("ix_resources_org_status", "organization_id", "status"),
        Index("ix_resources_tags", "tags", postgresql_using="gin"),
        UniqueConstraint("organization_id", "kind", "name", name="uq_resources_org_kind_name"),
    )


class ServerDetail(Base):
    __tablename__ = "servers"

    resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"), primary_key=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    hostname: Mapped[str] = mapped_column(String(255), default="")
    ip_address: Mapped[str] = mapped_column(String(64), default="")
    os_family: Mapped[str] = mapped_column(String(32), default="linux")
    os_version: Mapped[str] = mapped_column(String(200), default="")
    kernel: Mapped[str] = mapped_column(String(200), default="")
    cpu_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    memory_total_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    monitoring_interval_seconds: Mapped[int] = mapped_column(Integer, default=60)
    agent_timeout_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    thresholds: Mapped[dict[str, Any]] = mapped_column(default=dict)  # per-server overrides
    monitored_services: Mapped[list[str]] = mapped_column(ARRAY(String(128)), default=list)
    last_metrics_at: Mapped[datetime | None] = mapped_column(nullable=True)
    uptime_seconds: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Latest snapshot for list views (authoritative history lives in ClickHouse).
    latest: Mapped[dict[str, Any]] = mapped_column(default=dict)

    resource: Mapped[Resource] = relationship(back_populates="server", lazy="raise_on_sql")


class ResourceDependency(UUIDPk, Base):
    __tablename__ = "resource_dependencies"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"))
    depends_on_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"))
    description: Mapped[str] = mapped_column(String(300), default="")

    __table_args__ = (UniqueConstraint("resource_id", "depends_on_id", name="uq_resource_dependencies_pair"),)


class Check(UUIDPk, Timestamps, Base):
    __tablename__ = "checks"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(32))
    config: Mapped[dict[str, Any]] = mapped_column(default=dict)
    secret_config_enc: Mapped[str | None] = mapped_column(Text, nullable=True)  # encrypted JSON
    interval_seconds: Mapped[int] = mapped_column(Integer, default=60)
    timeout_seconds: Mapped[float] = mapped_column(Float, default=10.0)
    failure_threshold: Mapped[int] = mapped_column(Integer, default=2)  # consecutive failures → down
    recovery_threshold: Mapped[int] = mapped_column(Integer, default=1)  # consecutive successes → up
    severity: Mapped[str] = mapped_column(String(16), default="critical")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    # Scheduling state
    next_run_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_slot: Mapped[datetime | None] = mapped_column(nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(nullable=True)
    # Evaluation state
    last_outcome: Mapped[str] = mapped_column(String(16), default="unknown")
    last_message: Mapped[str] = mapped_column(String(1000), default="")
    last_latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    consecutive_successes: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(16), default="unknown")  # healthy|warning|critical|unknown
    state_changed_at: Mapped[datetime] = mapped_column(default=utcnow)

    resource: Mapped[Resource] = relationship(back_populates="checks", lazy="raise_on_sql")

    __table_args__ = (
        Index("ix_checks_due", "next_run_at", postgresql_where=text("enabled")),
        Index("ix_checks_org", "organization_id"),
    )


class Agent(UUIDPk, Timestamps, Base):
    __tablename__ = "agents"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="active")
    secret_hash: Mapped[str] = mapped_column(String(64))
    previous_secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    previous_secret_valid_until: Mapped[datetime | None] = mapped_column(nullable=True)
    version: Mapped[str] = mapped_column(String(32), default="")
    reported_hostname: Mapped[str] = mapped_column(String(255), default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(nullable=True)
    last_ip: Mapped[str] = mapped_column(String(64), default="")
    collection_interval_seconds: Mapped[int] = mapped_column(Integer, default=30)
    last_error: Mapped[str] = mapped_column(String(1000), default="")
    spool_depth: Mapped[int] = mapped_column(Integer, default=0)
    enrolled_at: Mapped[datetime] = mapped_column(default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)
    rotated_at: Mapped[datetime | None] = mapped_column(nullable=True)


class EnrollmentToken(UUIDPk, Base):
    __tablename__ = "agent_enrollment_tokens"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    description: Mapped[str] = mapped_column(String(200), default="")
    server_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"), nullable=True)
    defaults: Mapped[dict[str, Any]] = mapped_column(default=dict)  # environment, group_id, tags for new servers
    max_uses: Mapped[int] = mapped_column(Integer, default=1)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None] = mapped_column(nullable=True)


class MetricState(Base):
    """Current evaluated level of a server metric, used to dedupe threshold transitions."""

    __tablename__ = "metric_states"

    resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id", ondelete="CASCADE"), primary_key=True)
    metric_key: Mapped[str] = mapped_column(String(200), primary_key=True)  # e.g. cpu_percent, disk_percent:/var
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    level: Mapped[str] = mapped_column(String(16), default="healthy")
    pending_level: Mapped[str | None] = mapped_column(String(16), nullable=True)
    pending_count: Mapped[int] = mapped_column(Integer, default=0)
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    since: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow)
