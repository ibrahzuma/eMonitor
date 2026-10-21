"""Thin enqueue helpers so domain code does not import Celery task modules directly.

In tests (`set_inline(True)`) work is collected instead of being sent to the broker, and the
test drives it explicitly.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

log = logging.getLogger("emonitor.dispatch")

_inline = False
_collect = True
pending_deliveries: list[uuid.UUID] = []
pending_checks: list[tuple[uuid.UUID, datetime]] = []


def set_inline(enabled: bool, collect: bool = True) -> None:
    """Inline mode: don't touch the broker. `collect` keeps enqueued ids for tests to drive."""
    global _inline, _collect
    _inline = enabled
    _collect = collect
    pending_deliveries.clear()
    pending_checks.clear()


def enqueue_delivery(delivery_id: uuid.UUID) -> None:
    if _inline:
        if _collect:
            pending_deliveries.append(delivery_id)
        return
    from app.workers.tasks import send_delivery

    try:
        send_delivery.apply_async(args=[str(delivery_id)], queue="notifications")
    except Exception:  # broker down: the periodic due-delivery sweep will pick it up
        log.warning("could not enqueue delivery; will be retried by sweep", extra={"delivery_id": str(delivery_id)})


def enqueue_check(check_id: uuid.UUID, slot: datetime) -> bool:
    if _inline:
        if _collect:
            pending_checks.append((check_id, slot))
        return True
    from app.workers.tasks import run_check

    run_check.apply_async(args=[str(check_id), slot.isoformat()], queue="checks", expires=600)
    return True
