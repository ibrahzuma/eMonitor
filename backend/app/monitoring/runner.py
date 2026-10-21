"""Check execution: load config → run probe (no DB locks held) → apply result in a transaction."""

from __future__ import annotations

import logging
import socket
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.config import get_settings
from app.core.security import decrypt_json
from app.models import Check, Organization, Resource
from app.monitoring.check_configs import parse_secrets
from app.monitoring.evaluator import process_check_result
from app.monitoring.netguard import Scope
from app.monitoring.probes import ProbeContext, ProbeResult, run_probe
from app.telemetry.ingest import publish_rows

log = logging.getLogger("emonitor.runner")
WORKER_NAME = socket.gethostname()


async def load_probe_context(db: AsyncSession, check: Check) -> ProbeContext:
    org = await db.get(Organization, check.organization_id)
    secrets_model = None
    if check.secret_config_enc:
        secrets_model = parse_secrets(check.type, decrypt_json(check.secret_config_enc))
    else:
        secrets_model = parse_secrets(check.type, None)
    return ProbeContext(scope=Scope.from_org(org.monitoring_scope if org else {}), timeout=float(check.timeout_seconds),
                        secrets=secrets_model, previous=dict(check.last_details or {}))


async def execute_check(sessionmaker: Any, check_id: uuid.UUID, slot: datetime) -> dict[str, Any]:
    async with sessionmaker() as db:
        check = await db.get(Check, check_id)
        if check is None or not check.enabled:
            return {"ignored": "missing or disabled"}
        if check.last_slot is not None and slot <= check.last_slot:
            return {"ignored": "already processed"}
        resource = await db.get(Resource, check.resource_id)
        if resource is None or resource.is_paused:
            return {"ignored": "resource paused"}
        try:
            ctx = await load_probe_context(db, check)
        except Exception as exc:
            ctx = None
            result = ProbeResult.unknown(f"could not load check secrets: {exc}"[:300])
        check_type, config = check.type, dict(check.config)
        await db.rollback()  # release the snapshot before network I/O

    if ctx is not None:
        result = await run_probe(check_type, config, ctx)

    async with sessionmaker() as db:
        summary = await process_check_result(db, check_id, slot, result, worker=WORKER_NAME)
        await events.commit(db)
    return {"status": result.status.value, **summary}


async def record_skipped(org_id: uuid.UUID, check: Check, slots: list[datetime], reason: str) -> None:
    now = datetime.now(UTC)
    rows = [{
        "scheduled_at": s, "executed_at": now, "org_id": org_id, "check_id": check.id, "resource_id": check.resource_id,
        "check_type": check.type, "status": "skipped", "message": reason[:300], "worker": "scheduler",
    } for s in slots]
    await publish_rows("check_results", rows, enforce_backpressure=False)


def plan_slots(next_run_at: datetime, interval: int, now: datetime, max_missed: int = 1000) -> tuple[datetime, list[datetime], datetime]:
    """Return (slot_to_run, missed_slots, new_next_run_at) for a due check.

    If the scheduler fell behind (e.g. it was stopped), older slots are reported as missed so
    that they count as UNKNOWN in availability reports instead of silently disappearing.
    """
    step = timedelta(seconds=max(1, interval))
    behind = int((now - next_run_at) / step) if now > next_run_at else 0
    missed = [next_run_at + step * i for i in range(min(behind, max_missed))]
    slot = next_run_at + step * behind
    return slot, missed, slot + step


async def due_checks(db: AsyncSession, now: datetime, limit: int) -> list[Check]:
    stmt = (
        select(Check)
        .join(Resource, Resource.id == Check.resource_id)
        .where(Check.enabled.is_(True), Check.next_run_at <= now, Resource.is_paused.is_(False))
        .order_by(Check.next_run_at)
        .limit(limit)
        .with_for_update(of=Check, skip_locked=True)
    )
    return list((await db.scalars(stmt)).all())


async def schedule_tick(sessionmaker: Any, enqueue: Any, now: datetime | None = None,
                        queue_depth: int | None = None) -> dict[str, int]:
    """One scheduler iteration. Safe to run concurrently in several scheduler processes."""
    s = get_settings()
    now = now or datetime.now(UTC)
    if queue_depth is not None and queue_depth >= s.check_queue_max_depth:
        log.warning("check queue saturated; deferring dispatch", extra={"depth": queue_depth})
        return {"dispatched": 0, "missed": 0, "deferred": 1}
    dispatched = missed_total = 0
    async with sessionmaker() as db:
        checks = await due_checks(db, now, s.scheduler_batch_size)
        plans: list[tuple[Check, datetime, list[datetime]]] = []
        for c in checks:
            slot, missed, nxt = plan_slots(c.next_run_at, c.interval_seconds, now)
            c.next_run_at = nxt
            plans.append((c, slot, missed))
        await db.commit()
    for c, slot, missed in plans:
        if missed:
            missed_total += len(missed)
            try:
                await record_skipped(c.organization_id, c, missed, "scheduler did not dispatch this slot in time")
            except Exception:
                log.warning("could not record skipped slots")
        try:
            enqueue(c.id, slot)
            dispatched += 1
        except Exception:
            log.exception("failed to enqueue check", extra={"check_id": str(c.id)})
            try:
                await record_skipped(c.organization_id, c, [slot], "queue unavailable")
            except Exception:
                pass
    return {"dispatched": dispatched, "missed": missed_total, "deferred": 0}
