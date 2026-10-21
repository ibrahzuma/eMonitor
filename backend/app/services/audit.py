"""Audit trail for sensitive and administrative actions (stored in PostgreSQL)."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import Ctx, Principal
from app.models import AuditLog

_SENSITIVE_KEYS = {"password", "secret", "secrets", "token", "community", "bot_token", "smtp_password", "auth_key",
                   "priv_key", "v3_auth_key", "v3_priv_key", "signing_secret", "headers", "api_key", "totp"}


def scrub(data: Any) -> Any:
    if isinstance(data, dict):
        return {k: ("[REDACTED]" if any(s in k.lower() for s in _SENSITIVE_KEYS) else scrub(v)) for k, v in data.items()}
    if isinstance(data, list):
        return [scrub(v) for v in data[:100]]
    return data


def record(db: AsyncSession, *, action: str, ctx: Ctx | None = None, principal: Principal | None = None,
           org_id: uuid.UUID | None = None, target_type: str = "", target_id: Any = "",
           details: dict[str, Any] | None = None, ip: str = "", request_id: str = "") -> AuditLog:
    p = ctx.principal if ctx else principal
    entry = AuditLog(
        organization_id=org_id or (ctx.org_id if ctx else None),
        actor_user_id=p.user.id if p and p.user else None,
        actor_api_key_id=p.api_key.id if p and p.api_key else None,
        actor_label=p.label if p else "system",
        action=action,
        target_type=target_type,
        target_id=str(target_id or ""),
        details=scrub(details or {}),
        ip_address=ip or (ctx.ip if ctx else ""),
        request_id=request_id or (ctx.request_id if ctx else ""),
    )
    db.add(entry)
    return entry
