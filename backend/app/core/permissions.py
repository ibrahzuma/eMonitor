"""Role → permission mapping. Endpoints depend on permissions, never on role names directly."""

from __future__ import annotations

from enum import StrEnum

from app.models.enums import Role


class Permission(StrEnum):
    VIEW = "view"  # read any monitoring data in the org
    RESOURCES_WRITE = "resources:write"  # servers, websites, devices, services, checks, groups
    AGENTS_MANAGE = "agents:manage"  # enrollment tokens, revoke/rotate
    INCIDENTS_OPERATE = "incidents:operate"  # ack, assign, comment, resolve, create manual
    INCIDENTS_BULK = "incidents:bulk"
    ALERTS_MANAGE = "alerts:manage"  # alert rules
    NOTIFICATIONS_MANAGE = "notifications:manage"  # channels and policies
    MAINTENANCE_MANAGE = "maintenance:manage"
    SLO_MANAGE = "slo:manage"
    LOGS_READ = "logs:read"
    LOGS_WRITE = "logs:write"  # HTTP ingestion via API key
    METRICS_WRITE = "metrics:write"  # custom metric ingestion via API key
    USERS_MANAGE = "users:manage"  # memberships, teams
    API_KEYS_MANAGE = "api_keys:manage"
    ORG_SETTINGS = "org:settings"  # thresholds, scope, retention
    AUDIT_READ = "audit:read"
    PLATFORM_ADMIN = "platform:admin"  # create organizations, system status


_VIEWER = {Permission.VIEW, Permission.LOGS_READ}
_OPERATOR = _VIEWER | {Permission.INCIDENTS_OPERATE}
_IT_ADMIN = _OPERATOR | {
    Permission.RESOURCES_WRITE,
    Permission.AGENTS_MANAGE,
    Permission.INCIDENTS_BULK,
    Permission.ALERTS_MANAGE,
    Permission.NOTIFICATIONS_MANAGE,
    Permission.MAINTENANCE_MANAGE,
    Permission.SLO_MANAGE,
    Permission.LOGS_WRITE,
    Permission.METRICS_WRITE,
}
_ORG_ADMIN = _IT_ADMIN | {
    Permission.USERS_MANAGE,
    Permission.API_KEYS_MANAGE,
    Permission.ORG_SETTINGS,
    Permission.AUDIT_READ,
}

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.VIEWER: frozenset(_VIEWER),
    Role.OPERATOR: frozenset(_OPERATOR),
    Role.IT_ADMIN: frozenset(_IT_ADMIN),
    Role.ORG_ADMIN: frozenset(_ORG_ADMIN),
    Role.SUPER_ADMIN: frozenset(Permission),
}

ASSIGNABLE_ROLES = (Role.ORG_ADMIN, Role.IT_ADMIN, Role.OPERATOR, Role.VIEWER)
ROLE_RANK = {Role.VIEWER: 0, Role.OPERATOR: 1, Role.IT_ADMIN: 2, Role.ORG_ADMIN: 3, Role.SUPER_ADMIN: 4}

# Scopes an API key may be restricted to (subset of its role's permissions).
API_KEY_SCOPES = {p.value for p in Permission if p is not Permission.PLATFORM_ADMIN}


def permissions_for(role: Role | str, scopes: list[str] | None = None) -> frozenset[Permission]:
    perms = ROLE_PERMISSIONS.get(Role(role), frozenset())
    if scopes:
        perms = frozenset(p for p in perms if p.value in scopes)
    return perms
