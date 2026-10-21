"""Post-commit side effects: live events (Redis pub/sub), ClickHouse event rows, task kicks.

Domain code calls `defer(db, ...)` while inside a transaction; the caller runs
`await commit(db)` which commits and then executes the deferred actions. This keeps side
effects from being emitted for transactions that roll back.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import get_redis

log = logging.getLogger("emonitor.events")
_KEY = "post_commit"


def defer(db: AsyncSession, action: Callable[[], Awaitable[Any]]) -> None:
    db.info.setdefault(_KEY, []).append(action)


async def run_deferred(db: AsyncSession) -> None:
    actions = db.info.pop(_KEY, [])
    for action in actions:
        try:
            await action()
        except Exception:  # side effects are best-effort; durable state is already committed
            log.exception("post-commit action failed")


async def commit(db: AsyncSession) -> None:
    await db.commit()
    await run_deferred(db)


def discard_deferred(db: AsyncSession) -> None:
    db.info.pop(_KEY, None)


def channel_for(org_id: uuid.UUID | str) -> str:
    return f"emonitor:events:{org_id}"


async def publish_live(org_id: uuid.UUID, event_type: str, payload: dict[str, Any]) -> None:
    msg = json.dumps({"type": event_type, "ts": datetime.now(UTC).isoformat(), "data": payload}, default=str)
    try:
        await get_redis().publish(channel_for(org_id), msg)
    except Exception:
        log.warning("live event publish failed", extra={"event_type": event_type})


def emit(db: AsyncSession, org_id: uuid.UUID, event_type: str, payload: dict[str, Any], *,
         record: dict[str, Any] | None = None) -> None:
    """Queue a live event and (optionally) an `events` history row for after commit.

    `record` = {"kind", "severity", "title", "message", "resource_id", "data"}.
    """
    async def _live() -> None:
        await publish_live(org_id, event_type, payload)

    defer(db, _live)
    if record is not None:
        row = {
            "ts": datetime.now(UTC),
            "id": uuid.uuid4(),
            "org_id": org_id,
            "resource_id": record.get("resource_id") or uuid.UUID(int=0),
            "kind": record.get("kind", event_type),
            "severity": record.get("severity", "info"),
            "title": record.get("title", "")[:500],
            "message": record.get("message", "")[:2000],
            "data": json.dumps(record.get("data", {}), default=str),
        }

        async def _store() -> None:
            from app.telemetry.ingest import publish_rows

            await publish_rows("events", [row], enforce_backpressure=False)

        defer(db, _store)
