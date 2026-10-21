"""Incident engine: idempotent creation, deduplication, auto-resolution and reopening.

A *condition* (identified by a deterministic `dedup_key`) is either raised or cleared by the
monitoring pipeline. The partial unique index `uq_incidents_open_dedup` guarantees at most one
open incident per (organization, dedup_key) even with many concurrent workers.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.models import Incident, IncidentEvent, Organization, Resource
from app.models.enums import (
    OPEN_INCIDENT_STATUSES,
    SEVERITY_RANK,
    IncidentStatus,
    NotificationEvent,
    Severity,
)
from app.services import maintenance

log = logging.getLogger("emonitor.incidents")

Action = Literal["created", "updated", "reopened", "suppressed", "renotify"]


@dataclass
class ConditionResult:
    incident: Incident | None
    action: Action


def utcnow() -> datetime:
    return datetime.now(UTC)


async def next_incident_number(db: AsyncSession, org_id: uuid.UUID) -> int:
    return int(await db.scalar(
        update(Organization).where(Organization.id == org_id)
        .values(incident_seq=Organization.incident_seq + 1).returning(Organization.incident_seq)
        # Don't touch the in-session Organization object: a savepoint rollback would expire it.
        .execution_options(synchronize_session=False)
    ))


def add_event(db: AsyncSession, incident: Incident, kind: str, message: str = "", *,
              actor_id: uuid.UUID | None = None, data: dict[str, Any] | None = None) -> IncidentEvent:
    ev = IncidentEvent(
        incident_id=incident.id, organization_id=incident.organization_id, kind=kind, message=message[:4000],
        actor_user_id=actor_id, data=data or {}, created_at=utcnow(),
    )
    db.add(ev)
    return ev


def incident_payload(inc: Incident) -> dict[str, Any]:
    return {
        "id": str(inc.id), "number": inc.number, "title": inc.title, "severity": inc.severity, "status": inc.status,
        "resource_id": str(inc.resource_id) if inc.resource_id else None,
    }


def _emit(db: AsyncSession, inc: Incident, kind: str) -> None:
    events.emit(db, inc.organization_id, "incident", {**incident_payload(inc), "change": kind}, record={
        "kind": "incident", "severity": inc.severity, "resource_id": inc.resource_id,
        "title": f"INC-{inc.number} {kind}: {inc.title}", "data": {"incident_id": str(inc.id), "change": kind},
    })


async def _open_incident(db: AsyncSession, org_id: uuid.UUID, dedup_key: str) -> Incident | None:
    return await db.scalar(
        select(Incident).where(
            Incident.organization_id == org_id, Incident.dedup_key == dedup_key,
            Incident.status.in_([s.value for s in OPEN_INCIDENT_STATUSES]),
        ).with_for_update()
    )


async def raise_condition(
    db: AsyncSession,
    *,
    org: Organization,
    dedup_key: str,
    title: str,
    severity: Severity | str,
    source: str,
    source_id: str = "",
    resource: Resource | None = None,
    description: str = "",
    trigger_condition: str = "",
    evidence: dict[str, Any] | None = None,
    auto_resolve: bool = True,
    alert_rule_id: uuid.UUID | None = None,
    notification_policy_id: uuid.UUID | None = None,
    renotify_marker: str | None = None,
    now: datetime | None = None,
) -> ConditionResult:
    """Record that a condition is (still) occurring. Idempotent per dedup_key."""
    now = now or utcnow()
    severity = Severity(severity)
    org_id = org.id  # plain values only below: savepoint rollbacks may expire ORM state
    org_settings = dict(org.settings or {})
    if notification_policy_id is None and resource is not None:
        pid = (resource.attributes or {}).get("notification_policy_id")
        notification_policy_id = uuid.UUID(str(pid)) if pid else None
    windows = await maintenance.windows_for_resource(db, resource, org_id, now)
    in_maint = bool(windows)

    existing = await _open_incident(db, org_id, dedup_key)
    if existing:
        return await _update_existing(db, existing, severity, evidence, trigger_condition, renotify_marker, now)

    if in_maint and any(w.suppress_incidents for w in windows):
        return ConditionResult(None, "suppressed")

    reopen_window = timedelta(minutes=int(org_settings.get("reopen_window_minutes", 60)))
    recent = await db.scalar(
        select(Incident).where(
            Incident.organization_id == org_id, Incident.dedup_key == dedup_key,
            Incident.status == IncidentStatus.RESOLVED, Incident.resolved_at >= now - reopen_window,
        ).order_by(Incident.resolved_at.desc()).limit(1).with_for_update()
    )
    if recent:
        try:
            async with db.begin_nested():
                recent.status = IncidentStatus.REOPENED
                recent.resolved_at = None
                recent.resolved_by_id = None
                recent.reopen_count += 1
                recent.occurrence_count += 1
                recent.last_detected_at = now
                recent.acknowledged_at = None
                recent.acknowledged_by_id = None
                recent.in_maintenance = in_maint
                if SEVERITY_RANK[severity] > SEVERITY_RANK[Severity(recent.severity)]:
                    recent.severity = severity
                if evidence:
                    recent.evidence = {**(recent.evidence or {}), **evidence, "reopened_at": now.isoformat()}
                if renotify_marker:
                    recent.evidence = {**(recent.evidence or {}), "renotify_marker": renotify_marker}
                recent.escalation_step = 0
                await db.flush()
        except IntegrityError:
            existing = await _open_incident(db, org_id, dedup_key)
            if existing:
                return await _update_existing(db, existing, severity, evidence, trigger_condition, renotify_marker, now)
            raise
        add_event(db, recent, "reopened", f"Condition returned: {trigger_condition or title}",
                  data={"evidence": evidence or {}})
        await _after_trigger(db, recent, NotificationEvent.REOPENED, now)
        return ConditionResult(recent, "reopened")

    number = None
    try:
        async with db.begin_nested():
            number = await next_incident_number(db, org_id)
            inc = Incident(
                organization_id=org_id,
                number=number,
                title=title[:300],
                description=description,
                severity=severity,
                status=IncidentStatus.TRIGGERED,
                source=source,
                source_id=source_id,
                dedup_key=dedup_key,
                resource_id=resource.id if resource else None,
                team_id=resource.team_id if resource else None,
                alert_rule_id=alert_rule_id,
                notification_policy_id=notification_policy_id,
                trigger_condition=trigger_condition[:1000],
                evidence={**(evidence or {}), **({"renotify_marker": renotify_marker} if renotify_marker else {})},
                first_detected_at=now,
                last_detected_at=now,
                auto_resolve=auto_resolve,
                in_maintenance=in_maint,
                group_key=f"resource:{resource.id}" if resource else dedup_key,
                created_at=now,
                updated_at=now,
            )
            db.add(inc)
            await db.flush()
    except IntegrityError:
        # Another worker created the incident concurrently: fall back to updating it.
        existing = await _open_incident(db, org_id, dedup_key)
        if existing is None:
            raise
        return await _update_existing(db, existing, severity, evidence, trigger_condition, renotify_marker, now)

    add_event(db, inc, "created", trigger_condition or title,
              data={"evidence": evidence or {}, "in_maintenance": in_maint})
    if in_maint:
        add_event(db, inc, "maintenance", "Resource is in a maintenance window; notifications follow window policy",
                  data={"windows": [str(w.id) for w in windows]})
    await _after_trigger(db, inc, NotificationEvent.TRIGGERED, now)
    return ConditionResult(inc, "created")


async def _update_existing(db: AsyncSession, inc: Incident, severity: Severity, evidence: dict[str, Any] | None,
                           trigger_condition: str, renotify_marker: str | None, now: datetime) -> ConditionResult:
    inc.last_detected_at = now
    inc.occurrence_count += 1
    if evidence:
        inc.evidence = {**(inc.evidence or {}), **evidence}
    action: Action = "updated"
    if SEVERITY_RANK[severity] > SEVERITY_RANK[Severity(inc.severity)]:
        add_event(db, inc, "severity_changed", f"Severity raised from {inc.severity} to {severity}",
                  data={"from": inc.severity, "to": severity})
        inc.severity = severity
        action = "renotify"
    prev_marker = (inc.evidence or {}).get("renotify_marker")
    if renotify_marker and renotify_marker != prev_marker:
        inc.evidence = {**(inc.evidence or {}), "renotify_marker": renotify_marker}
        if trigger_condition:
            add_event(db, inc, "updated", trigger_condition)
        action = "renotify"
    if trigger_condition:
        inc.trigger_condition = trigger_condition[:1000]
    if action == "renotify":
        from app.notifications.planner import plan_notifications

        await plan_notifications(db, inc, NotificationEvent.TRIGGERED, marker=renotify_marker or inc.severity, now=now)
        _emit(db, inc, "updated")
    return ConditionResult(inc, action)


async def _after_trigger(db: AsyncSession, inc: Incident, event: NotificationEvent, now: datetime) -> None:
    from app.notifications.planner import plan_notifications, schedule_escalation

    marker = str(inc.reopen_count) if event == NotificationEvent.REOPENED else None
    await plan_notifications(db, inc, event, marker=marker, now=now)
    await schedule_escalation(db, inc, now)
    _emit(db, inc, "triggered" if event == NotificationEvent.TRIGGERED else "reopened")


async def clear_condition(db: AsyncSession, *, org_id: uuid.UUID, dedup_key: str, message: str = "",
                          evidence: dict[str, Any] | None = None, now: datetime | None = None) -> Incident | None:
    """Record that a condition recovered. Auto-resolves the open incident if configured."""
    now = now or utcnow()
    inc = await _open_incident(db, org_id, dedup_key)
    if not inc:
        return None
    if evidence:
        inc.evidence = {**(inc.evidence or {}), "recovery": evidence}
    if not inc.auto_resolve:
        add_event(db, inc, "recovered", message or "Monitored condition recovered (manual resolution required)")
        _emit(db, inc, "recovered")
        return inc
    await resolve(db, inc, resolution=message or "Automatically resolved: monitored condition recovered", actor_id=None,
                  now=now, automatic=True)
    return inc


async def resolve(db: AsyncSession, inc: Incident, *, resolution: str, actor_id: uuid.UUID | None,
                  now: datetime | None = None, automatic: bool = False) -> None:
    from app.notifications.planner import plan_notifications

    now = now or utcnow()
    if inc.status == IncidentStatus.RESOLVED:
        return
    inc.status = IncidentStatus.RESOLVED
    inc.resolved_at = now
    inc.resolved_by_id = actor_id
    inc.resolution = resolution[:4000]
    inc.next_escalation_at = None
    add_event(db, inc, "resolved", resolution, actor_id=actor_id, data={"automatic": automatic})
    await plan_notifications(db, inc, NotificationEvent.RESOLVED, marker=str(inc.reopen_count), now=now)
    _emit(db, inc, "resolved")


async def acknowledge(db: AsyncSession, inc: Incident, actor_id: uuid.UUID | None, note: str = "") -> bool:
    from app.notifications.planner import plan_notifications

    if inc.status not in (IncidentStatus.TRIGGERED, IncidentStatus.REOPENED):
        return False
    now = utcnow()
    inc.status = IncidentStatus.ACKNOWLEDGED
    inc.acknowledged_at = now
    inc.acknowledged_by_id = actor_id
    inc.next_escalation_at = None
    if inc.assignee_id is None and actor_id is not None:
        inc.assignee_id = actor_id
    add_event(db, inc, "acknowledged", note or "Incident acknowledged", actor_id=actor_id)
    await plan_notifications(db, inc, NotificationEvent.ACKNOWLEDGED, marker=str(inc.reopen_count), now=now)
    _emit(db, inc, "acknowledged")
    return True


async def set_investigating(db: AsyncSession, inc: Incident, actor_id: uuid.UUID | None, note: str = "") -> bool:
    if inc.status == IncidentStatus.RESOLVED:
        return False
    if inc.acknowledged_at is None:
        inc.acknowledged_at = utcnow()
        inc.acknowledged_by_id = actor_id
    inc.status = IncidentStatus.INVESTIGATING
    inc.next_escalation_at = None
    add_event(db, inc, "status_changed", note or "Investigation started", actor_id=actor_id,
              data={"status": IncidentStatus.INVESTIGATING})
    _emit(db, inc, "investigating")
    return True


async def manual_reopen(db: AsyncSession, inc: Incident, actor_id: uuid.UUID | None, note: str = "") -> bool:
    if inc.status != IncidentStatus.RESOLVED:
        return False
    if await _open_incident(db, inc.organization_id, inc.dedup_key):
        return False  # a newer open incident already tracks this condition
    inc.status = IncidentStatus.REOPENED
    inc.resolved_at = None
    inc.resolved_by_id = None
    inc.reopen_count += 1
    add_event(db, inc, "reopened", note or "Manually reopened", actor_id=actor_id)
    _emit(db, inc, "reopened")
    return True
