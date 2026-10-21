from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.models.enums import CheckType, Environment, ResourceKind, Severity
from app.schemas.common import ORM

_TAG = r"^[A-Za-z0-9_.:/\-]{1,64}$"


class CheckIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: CheckType
    config: dict[str, Any]
    secrets: dict[str, Any] | None = None  # write-only
    interval_seconds: int = Field(default=60, ge=10, le=86400)
    timeout_seconds: float = Field(default=10, gt=0, le=120)
    failure_threshold: int = Field(default=2, ge=1, le=100)
    recovery_threshold: int = Field(default=1, ge=1, le=100)
    severity: Severity = Severity.CRITICAL
    enabled: bool = True


class CheckUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    config: dict[str, Any] | None = None
    secrets: dict[str, Any] | None = None
    interval_seconds: int | None = Field(default=None, ge=10, le=86400)
    timeout_seconds: float | None = Field(default=None, gt=0, le=120)
    failure_threshold: int | None = Field(default=None, ge=1, le=100)
    recovery_threshold: int | None = Field(default=None, ge=1, le=100)
    severity: Severity | None = None
    enabled: bool | None = None


class CheckOut(ORM):
    id: uuid.UUID
    resource_id: uuid.UUID
    name: str
    type: str
    config: dict[str, Any]
    has_secrets: bool = False
    interval_seconds: int
    timeout_seconds: float
    failure_threshold: int
    recovery_threshold: int
    severity: str
    enabled: bool
    next_run_at: datetime
    last_run_at: datetime | None
    last_outcome: str
    last_message: str
    last_latency_ms: float | None
    last_details: dict[str, Any]
    consecutive_failures: int
    consecutive_successes: int
    state: str
    state_changed_at: datetime
    created_at: datetime


class ResourceBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    address: str = Field(default="", max_length=2048)
    environment: Environment = Environment.PRODUCTION
    location: str = Field(default="", max_length=200)
    business_owner: str = Field(default="", max_length=200)
    group_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    tags: list[str] = Field(default_factory=list, max_length=50)
    custom_fields: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)
    notification_policy_id: uuid.UUID | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str]) -> list[str]:
        import re

        out = []
        for t in v:
            t = t.strip()
            if not re.match(_TAG, t):
                raise ValueError(f"invalid tag {t!r}")
            out.append(t)
        return list(dict.fromkeys(out))

    @field_validator("custom_fields")
    @classmethod
    def _cf(cls, v: dict[str, Any]) -> dict[str, Any]:
        if len(v) > 50:
            raise ValueError("at most 50 custom fields")
        for k, val in v.items():
            if len(k) > 64 or (isinstance(val, str) and len(val) > 1000):
                raise ValueError("custom field too long")
        return v


class ResourceCreate(ResourceBase):
    kind: ResourceKind
    checks: list[CheckIn] = Field(default_factory=list, max_length=20)


class ResourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    address: str | None = Field(default=None, max_length=2048)
    environment: Environment | None = None
    location: str | None = Field(default=None, max_length=200)
    business_owner: str | None = Field(default=None, max_length=200)
    group_id: uuid.UUID | None = None
    team_id: uuid.UUID | None = None
    tags: list[str] | None = None
    custom_fields: dict[str, str | int | float | bool | None] | None = None
    attributes: dict[str, Any] | None = None
    notification_policy_id: uuid.UUID | None = None
    is_paused: bool | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else ResourceBase._tags(v)  # type: ignore[arg-type]


class ServerFields(BaseModel):
    hostname: str = Field(default="", max_length=255)
    ip_address: str = Field(default="", max_length=64)
    os_family: Literal["linux", "windows", "other"] = "linux"
    os_version: str = Field(default="", max_length=200)
    monitoring_interval_seconds: int = Field(default=30, ge=10, le=3600)
    agent_timeout_seconds: int | None = Field(default=None, ge=30, le=86400)
    thresholds: dict[str, dict[str, float]] = Field(default_factory=dict)
    monitored_services: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("monitored_services")
    @classmethod
    def _svc(cls, v: list[str]) -> list[str]:
        import re

        for s in v:
            if not re.fullmatch(r"[A-Za-z0-9@._\-]{1,128}", s):
                raise ValueError(f"invalid service name {s!r}")
        return v


class ServerCreate(ResourceBase, ServerFields):
    ping_check: bool = False  # add an ICMP reachability check against hostname/ip


class ServerUpdate(ResourceUpdate):
    hostname: str | None = Field(default=None, max_length=255)
    ip_address: str | None = Field(default=None, max_length=64)
    os_family: Literal["linux", "windows", "other"] | None = None
    os_version: str | None = Field(default=None, max_length=200)
    monitoring_interval_seconds: int | None = Field(default=None, ge=10, le=3600)
    agent_timeout_seconds: int | None = Field(default=None, ge=30, le=86400)
    thresholds: dict[str, dict[str, float]] | None = None
    monitored_services: list[str] | None = None


class ServerDetailOut(ORM):
    hostname: str
    ip_address: str
    os_family: str
    os_version: str
    kernel: str
    cpu_count: int | None
    memory_total_bytes: int | None
    monitoring_interval_seconds: int
    agent_timeout_seconds: int | None
    thresholds: dict[str, Any]
    monitored_services: list[str]
    last_metrics_at: datetime | None
    uptime_seconds: int | None
    latest: dict[str, Any]


class AgentBrief(ORM):
    id: uuid.UUID
    status: str
    version: str
    last_seen_at: datetime | None
    last_ip: str
    collection_interval_seconds: int
    spool_depth: int
    last_error: str
    enrolled_at: datetime


class ResourceOut(ORM):
    id: uuid.UUID
    kind: str
    name: str
    description: str
    address: str
    environment: str
    location: str
    business_owner: str
    group_id: uuid.UUID | None
    team_id: uuid.UUID | None
    tags: list[str]
    custom_fields: dict[str, Any]
    attributes: dict[str, Any]
    status: str
    status_reason: str
    status_changed_at: datetime
    is_paused: bool
    created_at: datetime
    updated_at: datetime
    server: ServerDetailOut | None = None
    agent: AgentBrief | None = None
    checks: list[CheckOut] | None = None
    open_incidents: int | None = None
    uptime_24h: float | None = None


class WebsiteCreate(ResourceBase):
    url: str = Field(max_length=2048)
    kind: Literal["website", "api"] = "website"
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] = "GET"
    expected_status: list[str] = Field(default_factory=lambda: ["200-399"])
    interval_seconds: int = Field(default=60, ge=10, le=86400)
    timeout_seconds: float = Field(default=10, gt=0, le=60)
    keyword: str | None = None
    keyword_absent: bool = False
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | None = None
    expected_headers: dict[str, str] = Field(default_factory=dict)
    json_assertions: list[dict[str, Any]] = Field(default_factory=list)
    verify_tls: bool = True
    ssl_check: bool = True
    ssl_alert_days: list[int] | None = None
    degraded_threshold_ms: float | None = None
    follow_redirects: bool = True
    failure_threshold: int = Field(default=2, ge=1, le=100)
    severity: Severity = Severity.CRITICAL
    secrets: dict[str, Any] | None = None
    # Extra coverage created alongside the HTTP check
    monitor_dns: bool = True
    dns_record_type: Literal["A", "AAAA", "CNAME"] = "A"
    monitor_domain: bool = True
    domain: str | None = Field(default=None, max_length=253)  # default: registrable domain of the URL
    domain_alert_days: list[int] | None = None


class NetworkDeviceCreate(ResourceBase):
    host: str = Field(min_length=1, max_length=253)
    vendor: str = Field(default="", max_length=100)
    model: str = Field(default="", max_length=100)
    device_type: Literal["router", "switch", "firewall", "access_point", "load_balancer", "other"] = "other"
    ping: bool = True
    ping_interval_seconds: int = Field(default=60, ge=10, le=86400)
    snmp: dict[str, Any] | None = None  # SnmpConfig fields without host
    snmp_secrets: dict[str, Any] | None = None
    snmp_interval_seconds: int = Field(default=300, ge=30, le=86400)


class ServiceCreate(ResourceBase):
    kind: Literal["service", "database", "application", "api"] = "service"
    checks: list[CheckIn] = Field(min_length=1, max_length=20)


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    parent_id: uuid.UUID | None = None


class GroupOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    parent_id: uuid.UUID | None
    created_at: datetime
    resource_count: int = 0


class DependencyIn(BaseModel):
    depends_on_id: uuid.UUID
    description: str = Field(default="", max_length=300)


class DependencyOut(ORM):
    id: uuid.UUID
    resource_id: uuid.UUID
    depends_on_id: uuid.UUID
    description: str


class ImportItem(ResourceCreate):
    pass


class ImportRequest(BaseModel):
    items: list[dict[str, Any]] = Field(min_length=1, max_length=1000)
    dry_run: bool = False


class ImportResult(BaseModel):
    created: int
    errors: list[dict[str, Any]]
    ids: list[uuid.UUID]
