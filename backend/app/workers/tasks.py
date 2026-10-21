"""Celery tasks. Each task is a thin synchronous wrapper around async domain code."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update

from app.core import events
from app.core.db import get_sessionmaker
from app.workers.celery_app import celery_app
from app.workers.runtime import run

log = logging.getLogger("emonitor.tasks")


@celery_app.task(name="emonitor.run_check", acks_late=True, max_retries=0)
def run_check(check_id: str, slot_iso: str) -> dict:
    from app.monitoring.runner import execute_check

    return run(execute_check(get_sessionmaker(), uuid.UUID(check_id), datetime.fromisoformat(slot_iso)))


@celery_app.task(name="emonitor.send_delivery", acks_late=True)
def send_delivery(delivery_id: str) -> str:
    from app.notifications.sender import send_delivery as _send

    async def _go() -> str:
        async with get_sessionmaker()() as db:
            return await _send(db, uuid.UUID(delivery_id))

    return run(_go())


@celery_app.task(name="emonitor.dispatch_due_deliveries")
def dispatch_due_deliveries() -> int:
    """Sweep for pending deliveries whose retry time arrived (also covers lost broker messages)."""
    from app.notifications.sender import due_deliveries

    async def _go() -> list[uuid.UUID]:
        async with get_sessionmaker()() as db:
            return await due_deliveries(db)

    ids = run(_go())
    for d in ids:
        send_delivery.apply_async(args=[str(d)], queue="notifications")
    return len(ids)


@celery_app.task(name="emonitor.process_escalations")
def process_escalations() -> int:
    from app.notifications.planner import escalate_due

    async def _go() -> int:
        async with get_sessionmaker()() as db:
            n = await escalate_due(db)
            await events.commit(db)
            return n

    return run(_go())


@celery_app.task(name="emonitor.evaluate_agent_liveness")
def evaluate_agent_liveness() -> int:
    from app.monitoring.evaluator import evaluate_agent_liveness as _eval

    async def _go() -> int:
        async with get_sessionmaker()() as db:
            n = await _eval(db)
            await events.commit(db)
            return n

    return run(_go())


@celery_app.task(name="emonitor.evaluate_rules")
def evaluate_rules() -> int:
    from app.alerts.evaluator import evaluate_due_rules

    return run(evaluate_due_rules(get_sessionmaker()))


@celery_app.task(name="emonitor.evaluate_slos")
def evaluate_slos() -> int:
    from app.models import Slo
    from app.services.availability import evaluate_slo

    async def _go() -> int:
        sm = get_sessionmaker()
        async with sm() as db:
            ids = list((await db.scalars(select(Slo.id))).all())
        for sid in ids:
            async with sm() as db:
                slo = await db.get(Slo, sid)
                if slo:
                    try:
                        await evaluate_slo(db, slo)
                        await events.commit(db)
                    except Exception:
                        log.exception("SLO evaluation failed", extra={"slo_id": str(sid)})
                        await db.rollback()
        return len(ids)

    return run(_go())


@celery_app.task(name="emonitor.refresh_maintenance_status")
def refresh_maintenance_status() -> int:
    """Re-evaluate resource status so maintenance windows starting/ending are reflected."""
    from app.models import MaintenanceWindow, Resource
    from app.monitoring.evaluator import recompute_resource_status
    from app.services import maintenance

    async def _go() -> int:
        now = datetime.now(UTC)
        changed = 0
        async with get_sessionmaker()() as db:
            windows = (await db.scalars(select(MaintenanceWindow).where(MaintenanceWindow.is_active.is_(True)))).all()
            orgs = {w.organization_id for w in windows}
            for w in windows:  # automatic expiration of finished windows
                if maintenance.is_expired(w, now):
                    w.is_active = False
            res = (await db.scalars(select(Resource).where(
                (Resource.organization_id.in_(orgs)) | (Resource.status == "maintenance")))).all() if orgs else \
                (await db.scalars(select(Resource).where(Resource.status == "maintenance"))).all()
            for r in res:
                before = r.status
                if await recompute_resource_status(db, r, now=now) != before:
                    changed += 1
            await events.commit(db)
        return changed

    return run(_go())


@celery_app.task(name="emonitor.housekeeping")
def housekeeping() -> dict:
    """Purge expired sessions/tokens and old delivery logs (transactional data retention)."""
    from app.models import EnrollmentToken, NotificationDelivery, PasswordResetToken, UserSession

    async def _go() -> dict:
        now = datetime.now(UTC)
        async with get_sessionmaker()() as db:
            s = await db.execute(delete(UserSession).where(UserSession.expires_at < now - timedelta(days=1)))
            p = await db.execute(delete(PasswordResetToken).where(PasswordResetToken.expires_at < now - timedelta(days=1)))
            e = await db.execute(delete(EnrollmentToken).where(EnrollmentToken.expires_at < now - timedelta(days=30)))
            d = await db.execute(delete(NotificationDelivery).where(NotificationDelivery.created_at < now - timedelta(days=180)))
            await db.execute(update(NotificationDelivery).where(
                NotificationDelivery.status == "pending", NotificationDelivery.created_at < now - timedelta(days=2)
            ).values(status="failed", status_reason="expired", next_attempt_at=None))
            await db.commit()
            return {"sessions": s.rowcount, "reset_tokens": p.rowcount, "enroll_tokens": e.rowcount,
                    "deliveries": d.rowcount}

    return run(_go())


@celery_app.task(name="emonitor.worker_heartbeat")
def worker_heartbeat() -> None:
    from app.core.redis import get_redis

    async def _go() -> None:
        await get_redis().set("emonitor:heartbeat:worker", datetime.now(UTC).isoformat(), ex=120)

    run(_go())
