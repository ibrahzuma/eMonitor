"""Notification routing: incident events → policy → channels → delivery rows (outbox).

Deliveries are inserted in the same transaction as the incident change (transactional outbox),
then sent by the `send_delivery` Celery task. A unique `dedup_key` per
(incident, channel, event, step, marker) makes planning idempotent.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models import (
    InAppNotification,
    Incident,
    Membership,
    NotificationChannel,
    NotificationDelivery,
    NotificationPolicy,
    Resource,
    Team,
)
from app.models.enums import SEVERITY_RANK, ChannelType, DeliveryStatus, NotificationEvent, Severity
from app.notifications.templates import render_message
from app.services import maintenance

log = logging.getLogger("emonitor.notifications")


async def resolve_policy(db: AsyncSession, inc: Incident) -> NotificationPolicy | None:
    if inc.notification_policy_id:
        p = await db.get(NotificationPolicy, inc.notification_policy_id)
        if p and p.enabled:
            return p
    policies = (await db.scalars(
        select(NotificationPolicy).where(NotificationPolicy.organization_id == inc.organization_id,
                                         NotificationPolicy.enabled.is_(True))
        .order_by(NotificationPolicy.priority, NotificationPolicy.created_at)
    )).all()
    sev = SEVERITY_RANK[Severity(inc.severity)]
    for p in policies:
        if p.is_default:
            continue
        if sev < SEVERITY_RANK[Severity(p.min_severity)]:
            continue
        if p.team_ids and inc.team_id not in p.team_ids:
            continue
        return p
    for p in policies:
        if p.is_default and sev >= SEVERITY_RANK[Severity(p.min_severity)]:
            return p
    return None


def in_quiet_hours(quiet: dict[str, Any] | None, now: datetime, severity: str) -> bool:
    if not quiet or not quiet.get("enabled"):
        return False
    if severity == Severity.CRITICAL and quiet.get("allow_critical", True):
        return False
    try:
        tz = ZoneInfo(quiet.get("timezone") or "UTC")
        start = time.fromisoformat(quiet.get("start", "22:00"))
        end = time.fromisoformat(quiet.get("end", "07:00"))
    except (ValueError, KeyError):
        return False
    local = now.astimezone(tz)
    if quiet.get("weekdays") and local.weekday() not in quiet["weekdays"]:
        return False
    t = local.time()
    return (start <= t < end) if start <= end else (t >= start or t < end)


def _steps(policy: NotificationPolicy) -> list[dict[str, Any]]:
    steps = policy.steps or []
    return [s for s in steps if isinstance(s, dict)]


async def plan_notifications(db: AsyncSession, inc: Incident, event: NotificationEvent, *, marker: str | None = None,
                             step: int | None = None, now: datetime | None = None) -> list[NotificationDelivery]:
    now = now or datetime.now(UTC)
    policy = await resolve_policy(db, inc)
    if policy is None:
        return []
    if event == NotificationEvent.ACKNOWLEDGED and not policy.notify_on_ack:
        return []
    if event == NotificationEvent.RESOLVED and not policy.notify_on_resolve:
        return []
    steps = _steps(policy)
    if not steps:
        return []
    if event in (NotificationEvent.TRIGGERED, NotificationEvent.REOPENED):
        step_indexes = [0]
    elif event == NotificationEvent.ESCALATED:
        step_indexes = [step if step is not None else inc.escalation_step]
    else:  # ack / resolved go to everyone who was notified so far
        step_indexes = list(range(0, min(inc.escalation_step, len(steps) - 1) + 1))
    channel_ids: list[tuple[int, uuid.UUID]] = []
    for idx in step_indexes:
        if idx >= len(steps):
            continue
        for cid in steps[idx].get("channel_ids", []):
            try:
                channel_ids.append((idx, uuid.UUID(str(cid))))
            except ValueError:
                continue
    if not channel_ids:
        return []
    channels = {c.id: c for c in (await db.scalars(
        select(NotificationChannel).where(NotificationChannel.organization_id == inc.organization_id,
                                          NotificationChannel.id.in_([c for _, c in channel_ids]))
    )).all()}

    suppress_reason = ""
    if event != NotificationEvent.RESOLVED:
        resource = await db.get(Resource, inc.resource_id) if inc.resource_id else None
        windows = await maintenance.windows_for_resource(db, resource, inc.organization_id, now)
        if any(w.suppress_notifications for w in windows):
            suppress_reason = "maintenance window"
        elif in_quiet_hours(policy.quiet_hours, now, inc.severity):
            suppress_reason = "quiet hours"

    resource_name = None
    if inc.resource_id:
        resource_name = await db.scalar(select(Resource.name).where(Resource.id == inc.resource_id))
    created: list[NotificationDelivery] = []
    for idx, cid in channel_ids:
        ch = channels.get(cid)
        if ch is None or not ch.enabled:
            continue
        dedup = f"{inc.id}:{ch.id}:{event}:{idx}:{marker or ''}"
        subject, body = render_message(policy.templates or {}, inc, event, resource_name)
        status = DeliveryStatus.PENDING
        reason = ""
        if suppress_reason:
            status, reason = DeliveryStatus.SUPPRESSED, suppress_reason
        elif await _rate_limited(db, ch, now):
            status, reason = DeliveryStatus.SUPPRESSED, "channel rate limit reached"
        values = dict(
            id=uuid.uuid4(), organization_id=inc.organization_id, incident_id=inc.id, channel_id=ch.id,
            channel_type=ch.type, event=event, step=idx, dedup_key=dedup[:300], status=status, status_reason=reason,
            attempts=0, max_attempts=5, next_attempt_at=now if status == DeliveryStatus.PENDING else None,
            subject=subject[:500], body=body, created_at=now,
        )
        res = await db.execute(insert(NotificationDelivery).values(**values)
                               .on_conflict_do_nothing(index_elements=["dedup_key"]).returning(NotificationDelivery.id))
        new_id = res.scalar_one_or_none()
        if new_id is None:
            continue  # already planned (idempotent)
        delivery = await db.get(NotificationDelivery, new_id)
        assert delivery is not None
        created.append(delivery)
        if status == DeliveryStatus.PENDING:
            if ch.type == ChannelType.IN_APP:
                await _deliver_in_app(db, inc, ch, delivery, subject, body)
            else:
                _kick_sender(db, delivery.id)
    return created


async def _rate_limited(db: AsyncSession, ch: NotificationChannel, now: datetime) -> bool:
    if not ch.rate_limit_per_hour or ch.rate_limit_per_hour <= 0:
        return False
    count = await db.scalar(
        select(func.count()).select_from(NotificationDelivery).where(
            NotificationDelivery.channel_id == ch.id,
            NotificationDelivery.created_at >= now - timedelta(hours=1),
            NotificationDelivery.status.in_([DeliveryStatus.PENDING, DeliveryStatus.SENT, DeliveryStatus.FAILED]),
        )
    )
    return int(count or 0) >= ch.rate_limit_per_hour


async def _deliver_in_app(db: AsyncSession, inc: Incident, ch: NotificationChannel, delivery: NotificationDelivery,
                          subject: str, body: str) -> None:
    """In-app notifications are written directly for the target audience."""
    cfg = ch.config or {}
    user_ids: set[uuid.UUID] = set()
    if cfg.get("audience") == "team" and inc.team_id:
        team = await db.get(Team, inc.team_id)
        user_ids |= set(team.member_ids or []) if team else set()
    elif cfg.get("user_ids"):
        user_ids |= {uuid.UUID(str(u)) for u in cfg["user_ids"]}
    if not user_ids:  # default: all members of the organization
        user_ids |= set((await db.scalars(
            select(Membership.user_id).where(Membership.organization_id == inc.organization_id)
        )).all())
    member_ids = set((await db.scalars(
        select(Membership.user_id).where(Membership.organization_id == inc.organization_id,
                                         Membership.user_id.in_(user_ids))
    )).all()) if user_ids else set()
    for uid in member_ids:
        db.add(InAppNotification(organization_id=inc.organization_id, user_id=uid, incident_id=inc.id,
                                 title=subject[:300], body=body, severity=inc.severity))
    delivery.status = DeliveryStatus.SENT
    delivery.attempts = 1
    delivery.sent_at = datetime.now(UTC)
    delivery.next_attempt_at = None
    events.emit(db, inc.organization_id, "notification", {"incident_id": str(inc.id), "title": subject})


def _kick_sender(db: AsyncSession, delivery_id: uuid.UUID) -> None:
    async def _kick() -> None:
        from app.workers.dispatch import enqueue_delivery

        enqueue_delivery(delivery_id)

    events.defer(db, _kick)


async def schedule_escalation(db: AsyncSession, inc: Incident, now: datetime) -> None:
    policy = await resolve_policy(db, inc)
    steps = _steps(policy) if policy else []
    nxt = inc.escalation_step + 1
    if nxt < len(steps):
        delay = int(steps[nxt].get("delay_minutes", 0) or 0)
        inc.next_escalation_at = now + timedelta(minutes=max(1, delay))
    else:
        inc.next_escalation_at = None


async def escalate_due(db: AsyncSession, now: datetime | None = None, limit: int = 200) -> int:
    """Escalate unacknowledged incidents whose next escalation time has passed."""
    from app.models.enums import IncidentStatus

    now = now or datetime.now(UTC)
    incidents = (await db.scalars(
        select(Incident).where(
            Incident.next_escalation_at.is_not(None), Incident.next_escalation_at <= now,
            Incident.status.in_([IncidentStatus.TRIGGERED, IncidentStatus.REOPENED]),
        ).order_by(Incident.next_escalation_at).limit(limit).with_for_update(skip_locked=True)
    )).all()
    from app.incidents.engine import add_event

    for inc in incidents:
        inc.escalation_step += 1
        add_event(db, inc, "escalated", f"Escalated to step {inc.escalation_step + 1} (not acknowledged)")
        await plan_notifications(db, inc, NotificationEvent.ESCALATED, step=inc.escalation_step,
                                 marker=str(inc.reopen_count), now=now)
        await schedule_escalation(db, inc, now)
    return len(incidents)
