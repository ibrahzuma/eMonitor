"""Single-process development mode (EMONITOR_DEV_INLINE_WORKERS=true; refused in production).

Runs the scheduler, check execution, rule/SLO/escalation/delivery sweeps and agent-liveness
evaluation as asyncio tasks inside the API process, and writes telemetry directly to the
configured store. This lets developers run the whole platform without Celery workers; it is NOT
a deployment mode — production uses the separate systemd services.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from app.core import events
from app.core.db import get_sessionmaker

log = logging.getLogger("emonitor.devinline")
_tasks: list[asyncio.Task] = []


async def _every(seconds: float, fn) -> None:
    while True:
        try:
            await fn()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("inline worker iteration failed")
        await asyncio.sleep(seconds)


async def _scheduler() -> None:
    from app.monitoring.runner import execute_check, schedule_tick

    sm = get_sessionmaker()
    running: set[asyncio.Task] = set()

    def enqueue(check_id, slot) -> None:
        t = asyncio.create_task(execute_check(sm, check_id, slot))
        running.add(t)
        t.add_done_callback(running.discard)

    await schedule_tick(sm, enqueue, queue_depth=len(running))


async def _deliveries() -> None:
    from app.notifications.sender import due_deliveries, send_delivery

    sm = get_sessionmaker()
    async with sm() as db:
        ids = await due_deliveries(db)
    for d in ids:
        async with sm() as db:
            await send_delivery(db, d)


async def _escalations() -> None:
    from app.notifications.planner import escalate_due

    async with get_sessionmaker()() as db:
        await escalate_due(db)
        await events.commit(db)


async def _liveness() -> None:
    from app.monitoring.evaluator import evaluate_agent_liveness

    async with get_sessionmaker()() as db:
        await evaluate_agent_liveness(db)
        await events.commit(db)


async def _rules() -> None:
    from app.alerts.evaluator import evaluate_due_rules

    await evaluate_due_rules(get_sessionmaker())


async def _slos() -> None:
    from sqlalchemy import select

    from app.models import Slo
    from app.services.availability import evaluate_slo

    sm = get_sessionmaker()
    async with sm() as db:
        for slo in (await db.scalars(select(Slo))).all():
            await evaluate_slo(db, slo, datetime.now(UTC))
        await events.commit(db)


def start() -> None:
    from app.telemetry.ingest import set_direct_mode
    from app.workers import dispatch

    set_direct_mode(True)
    dispatch.set_inline(True, collect=False)  # deliveries are picked up by the sweep below
    log.warning("DEVELOPMENT inline workers enabled — not for production use")
    for seconds, fn in ((1.0, _scheduler), (5.0, _deliveries), (30.0, _escalations), (30.0, _liveness),
                        (15.0, _rules), (300.0, _slos)):
        _tasks.append(asyncio.create_task(_every(seconds, fn)))


async def stop() -> None:
    for t in _tasks:
        t.cancel()
    await asyncio.gather(*_tasks, return_exceptions=True)
    _tasks.clear()
