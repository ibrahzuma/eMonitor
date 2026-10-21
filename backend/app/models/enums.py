"""Domain enumerations. Stored as strings in the database (validated by Pydantic/application)."""

from enum import StrEnum


class Role(StrEnum):
    SUPER_ADMIN = "super_admin"  # platform-level, held via User.is_superadmin
    ORG_ADMIN = "org_admin"
    IT_ADMIN = "it_admin"
    OPERATOR = "operator"
    VIEWER = "viewer"


class ResourceKind(StrEnum):
    SERVER = "server"
    WEBSITE = "website"
    API = "api"
    NETWORK_DEVICE = "network_device"
    DATABASE = "database"
    APPLICATION = "application"
    SERVICE = "service"


class Environment(StrEnum):
    PRODUCTION = "production"
    STAGING = "staging"
    DEVELOPMENT = "development"
    TESTING = "testing"


class HealthStatus(StrEnum):
    HEALTHY = "healthy"
    WARNING = "warning"
    CRITICAL = "critical"
    UNREACHABLE = "unreachable"
    UNKNOWN = "unknown"
    MAINTENANCE = "maintenance"


# Severity order used when combining statuses (higher = worse).
HEALTH_RANK = {
    HealthStatus.HEALTHY: 0,
    HealthStatus.UNKNOWN: 1,
    HealthStatus.WARNING: 2,
    HealthStatus.CRITICAL: 3,
    HealthStatus.UNREACHABLE: 4,
}


class CheckType(StrEnum):
    HTTP = "http"
    TCP = "tcp"
    ICMP = "icmp"
    DNS = "dns"
    TLS = "tls"
    SMTP = "smtp"
    SSH = "ssh"
    POSTGRES = "postgres"
    MYSQL = "mysql"
    REDIS = "redis"
    SNMP = "snmp"


class CheckOutcomeStatus(StrEnum):
    UP = "up"
    DEGRADED = "degraded"  # reachable but violating a soft condition (e.g. slow)
    DOWN = "down"
    UNKNOWN = "unknown"  # probe could not determine (e.g. internal error, blocked)
    SKIPPED = "skipped"  # slot not executed (scheduler behind / backpressure)


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    WARNING = "warning"
    INFO = "info"


SEVERITY_RANK = {Severity.INFO: 0, Severity.WARNING: 1, Severity.HIGH: 2, Severity.CRITICAL: 3}


class IncidentStatus(StrEnum):
    TRIGGERED = "triggered"
    ACKNOWLEDGED = "acknowledged"
    INVESTIGATING = "investigating"
    RESOLVED = "resolved"
    REOPENED = "reopened"


OPEN_INCIDENT_STATUSES = (
    IncidentStatus.TRIGGERED,
    IncidentStatus.ACKNOWLEDGED,
    IncidentStatus.INVESTIGATING,
    IncidentStatus.REOPENED,
)


class IncidentSource(StrEnum):
    CHECK = "check"
    METRIC = "metric"
    AGENT = "agent"
    SSL = "ssl"
    RULE = "rule"
    LOG = "log"
    SLO = "slo"
    MANUAL = "manual"


class AlertRuleType(StrEnum):
    METRIC_THRESHOLD = "metric_threshold"
    CONSECUTIVE_FAILURES = "consecutive_failures"
    WEBSITE_DOWN = "website_down"
    RESPONSE_TIME = "response_time"
    SSL_EXPIRY = "ssl_expiry"
    LOG_PATTERN = "log_pattern"
    ERROR_RATE = "error_rate"
    MISSING_TELEMETRY = "missing_telemetry"
    AGENT_DISCONNECTED = "agent_disconnected"
    COMPOSITE = "composite"


class ChannelType(StrEnum):
    EMAIL = "email"
    TELEGRAM = "telegram"
    WEBHOOK = "webhook"
    IN_APP = "in_app"


class DeliveryStatus(StrEnum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    SUPPRESSED = "suppressed"


class NotificationEvent(StrEnum):
    TRIGGERED = "triggered"
    ESCALATED = "escalated"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"
    REOPENED = "reopened"
    TEST = "test"


class AgentStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    REVOKED = "revoked"
