"""Delivery execution with retries (exponential backoff) and delivery logging."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_json
from app.models import Incident, NotificationChannel, NotificationDelivery, Organization
from app.models.enums import DeliveryStatus
from app.monitoring.netguard import Scope
from app.notifications.providers import PROVIDERS, DeliveryError, OutgoingMessage

log = logging.getLogger("emonitor.notifications")

BACKOFF_BASE_SECONDS = 30
BACKOFF_MAX_SECONDS = 1800


def backoff(attempt: int) -> timedelta:
    return timedelta(seconds=min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** max(0, attempt - 1)))


async def send_delivery(db: AsyncSession, delivery_id: uuid.UUID, now: datetime | None = None) -> str:
    """Attempt one delivery. Returns the resulting status. Safe to call concurrently/duplicated."""
    now = now or datetime.now(UTC)
    d = await db.scalar(
        select(NotificationDelivery).where(NotificationDelivery.id == delivery_id)
        .with_for_update(skip_locked=True)
    )
    if d is None or d.status != DeliveryStatus.PENDING:
        return d.status if d else "missing"
    if d.next_attempt_at and d.next_attempt_at > now + timedelta(seconds=1):
        return "not_due"
    channel = await db.get(NotificationChannel, d.channel_id) if d.channel_id else None
    if channel is None or not channel.enabled:
        d.status, d.status_reason = DeliveryStatus.FAILED, "channel deleted or disabled"
        d.next_attempt_at = None
        await db.commit()
        return d.status
    provider = PROVIDERS.get(channel.type)
    if provider is None:
        d.status, d.status_reason = DeliveryStatus.FAILED, f"unknown provider {channel.type}"
        await db.commit()
        return d.status
    inc = await db.get(Incident, d.incident_id) if d.incident_id else None
    org = await db.get(Organization, d.organization_id)
    msg = OutgoingMessage(
        subject=d.subject, body=d.body, event=d.event, severity=inc.severity if inc else "info",
        incident={"id": str(inc.id), "number": inc.number, "title": inc.title, "status": inc.status,
                  "severity": inc.severity} if inc else {},
    )
    d.attempts += 1
    try:
        secrets = decrypt_json(channel.secret_enc)
        detail = await provider.send(channel.config or {}, secrets, msg, Scope.from_org(org.monitoring_scope if org else {}))
    except DeliveryError as exc:
        d.last_error = str(exc)[:1000]
        if not exc.retryable or d.attempts >= d.max_attempts:
            d.status = DeliveryStatus.FAILED
            d.status_reason = "permanent error" if not exc.retryable else "max attempts reached"
            d.next_attempt_at = None
        else:
            d.next_attempt_at = now + backoff(d.attempts)
        log.warning("notification delivery failed", extra={"delivery_id": str(d.id), "attempt": d.attempts,
                                                           "channel_type": channel.type, "error": d.last_error})
    except Exception as exc:  # unexpected: retry like a transient failure
        log.exception("notification provider crashed")
        d.last_error = f"internal error: {exc.__class__.__name__}"
        if d.attempts >= d.max_attempts:
            d.status, d.next_attempt_at = DeliveryStatus.FAILED, None
        else:
            d.next_attempt_at = now + backoff(d.attempts)
    else:
        d.status = DeliveryStatus.SENT
        d.sent_at = now
        d.status_reason = detail[:300]
        d.next_attempt_at = None
        d.last_error = ""
    if d.event == "test":
        channel.last_test_ok = d.status == DeliveryStatus.SENT
    await db.commit()
    return d.status


async def due_deliveries(db: AsyncSession, now: datetime | None = None, limit: int = 500) -> list[uuid.UUID]:
    now = now or datetime.now(UTC)
    return list((await db.scalars(
        select(NotificationDelivery.id).where(
            NotificationDelivery.status == DeliveryStatus.PENDING, NotificationDelivery.next_attempt_at <= now
        ).order_by(NotificationDelivery.next_attempt_at).limit(limit)
    )).all())
