"""Telemetry ingest buffer: Redis Stream between API/workers and ClickHouse writers.

Producers call `publish_rows(table, rows)`. The `emonitor-ingest` service consumes the stream in
a consumer group, batches rows per table, writes to ClickHouse, and acknowledges entries only
after a successful insert (at-least-once; ClickHouse tables tolerate duplicates —
`check_results` collapses them via ReplacingMergeTree).

Backpressure: when the stream length exceeds `ingest_high_watermark`, producers that enforce
backpressure receive `ServiceUnavailable` (HTTP 503 + Retry-After), so agents keep data in their
local spool instead of the platform buffering without bound.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from app.core.config import get_settings
from app.core.errors import ServiceUnavailable
from app.core.redis import get_redis

log = logging.getLogger("emonitor.ingest")

STREAM = "emonitor:ingest"
GROUP = "ingest-writers"
_DT_FIELDS = {"ts", "scheduled_at", "executed_at"}
_UUID_FIELDS = {"org_id", "resource_id", "check_id", "id"}

# Direct mode (tests / single-process dev): write straight to the store instead of Redis.
_direct_mode = False


def set_direct_mode(enabled: bool) -> None:
    global _direct_mode
    _direct_mode = enabled


def _default(o: Any) -> Any:
    if isinstance(o, datetime):
        return o.astimezone(UTC).isoformat()
    if isinstance(o, uuid.UUID):
        return str(o)
    raise TypeError(type(o))


def decode_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for r in rows:
        row = dict(r)
        for k in _DT_FIELDS & row.keys():
            if isinstance(row[k], str):
                row[k] = datetime.fromisoformat(row[k])
        for k in _UUID_FIELDS & row.keys():
            if isinstance(row[k], str):
                row[k] = uuid.UUID(row[k])
        out.append(row)
    return out


async def stream_length() -> int:
    try:
        return int(await get_redis().xlen(STREAM))
    except Exception:
        return -1


async def check_backpressure() -> None:
    s = get_settings()
    if _direct_mode:
        return
    length = await stream_length()
    if length < 0:
        raise ServiceUnavailable("telemetry buffer unavailable", retry_after=15)
    if length >= s.ingest_high_watermark:
        raise ServiceUnavailable("telemetry ingestion is saturated, retry later", retry_after=30)


async def publish_rows(table: str, rows: list[dict[str, Any]], *, enforce_backpressure: bool = True,
                       meta: dict[str, Any] | None = None) -> None:
    if not rows:
        return
    if _direct_mode:
        from app.telemetry.store import get_store

        await get_store().insert(table, rows)
        if meta and meta.get("evaluate") == "server_metrics":
            from app.workers.ingest import evaluate_agent_batch

            await evaluate_agent_batch(json.loads(json.dumps(meta, default=_default)), rows)
        return
    if enforce_backpressure:
        await check_backpressure()
    payload = {"t": table, "r": json.dumps(rows, default=_default, separators=(",", ":"))}
    if meta:
        payload["m"] = json.dumps(meta, default=_default)
    await get_redis().xadd(STREAM, payload, maxlen=get_settings().ingest_stream_maxlen, approximate=True)
