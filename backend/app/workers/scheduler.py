"""emonitor-scheduler: dispatches due checks from PostgreSQL to the Celery `checks` queue.

Run: `python -m app.workers.scheduler`. Multiple instances are safe (row-level SKIP LOCKED).
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from datetime import UTC, datetime

from app.core.config import get_settings
from app.core.db import dispose_engine, get_sessionmaker
from app.core.logging import configure_logging
from app.core.redis import close_redis, get_redis
from app.monitoring.runner import schedule_tick
from app.workers.dispatch import enqueue_check

log = logging.getLogger("emonitor.scheduler")
HEARTBEAT_KEY = "emonitor:heartbeat:scheduler"


async def _queue_depth() -> int | None:
    try:
        return int(await get_redis().llen("checks"))
    except Exception:
        return None


async def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows development
            pass
    sm = get_sessionmaker()
    log.info("scheduler started", extra={"tick_seconds": s.scheduler_tick_seconds})
    while not stop.is_set():
        started = time.monotonic()
        try:
            stats = await schedule_tick(sm, enqueue_check, queue_depth=await _queue_depth())
            if stats["dispatched"] or stats["missed"]:
                log.info("dispatched checks", extra=stats)
            await get_redis().set(HEARTBEAT_KEY, datetime.now(UTC).isoformat(), ex=120)
        except Exception:
            log.exception("scheduler tick failed")
        elapsed = time.monotonic() - started
        try:
            await asyncio.wait_for(stop.wait(), timeout=max(0.05, s.scheduler_tick_seconds - elapsed))
        except TimeoutError:
            pass
    log.info("scheduler stopping")
    await dispose_engine()
    await close_redis()


if __name__ == "__main__":
    asyncio.run(main())
