"""emonitor-ingest: drains the Redis ingest stream into ClickHouse in batches.

Run: `python -m app.workers.ingest`. Several consumers may run (same consumer group).
Entries are acknowledged only after ClickHouse accepted the batch; entries left pending by a
crashed consumer are reclaimed with XAUTOCLAIM after 60 s.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import socket
import time
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from app.core.config import get_settings
from app.core.db import dispose_engine, get_sessionmaker
from app.core.logging import configure_logging
from app.core.redis import close_redis, get_redis
from app.telemetry.ingest import GROUP, STREAM, decode_rows
from app.telemetry.store import get_store

log = logging.getLogger("emonitor.ingest")
CONSUMER = f"{socket.gethostname()}-{os.getpid()}"
HEARTBEAT_KEY = "emonitor:heartbeat:ingest"


async def ensure_group() -> None:
    r = get_redis()
    try:
        await r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except Exception as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def process_entries(entries: list[tuple[str, dict[str, str]]]) -> list[str]:
    """Insert a batch of stream entries; run post-insert evaluation. Returns ids to ack."""
    by_table: dict[str, list[dict[str, Any]]] = defaultdict(list)
    evaluations: list[dict[str, Any]] = []
    ids: list[str] = []
    for entry_id, fields in entries:
        ids.append(entry_id)
        table = fields.get("t")
        try:
            rows = decode_rows(json.loads(fields.get("r", "[]")))
        except ValueError:
            log.error("dropping malformed ingest entry", extra={"entry_id": entry_id})
            continue
        if table:
            by_table[table].extend(rows)
        if fields.get("m"):
            meta = json.loads(fields["m"])
            if meta.get("evaluate") == "server_metrics":
                evaluations.append({"meta": meta, "rows": rows})
    store = get_store()
    for table, rows in by_table.items():
        await store.insert(table, rows)  # raises → entries stay pending and are retried
    for ev in evaluations:
        try:
            await evaluate_agent_batch(ev["meta"], ev["rows"])
        except Exception:
            log.exception("threshold evaluation failed")
    return ids


async def evaluate_agent_batch(meta: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    from app.core import events
    from app.models import Organization, Resource, ServerDetail
    from app.monitoring.evaluator import evaluate_server_samples

    latest: dict[tuple[str, str], tuple[datetime, float]] = {}
    for r in rows:
        k = (r["metric"], r.get("instance", ""))
        if k not in latest or r["ts"] >= latest[k][0]:
            latest[k] = (r["ts"], float(r["value"]))
    samples = {k: v for k, (_, v) in latest.items()}
    sm = get_sessionmaker()
    async with sm() as db:
        org = await db.get(Organization, uuid.UUID(meta["org_id"]))
        resource = await db.get(Resource, uuid.UUID(meta["resource_id"]))
        server = await db.get(ServerDetail, uuid.UUID(meta["resource_id"]))
        if not (org and resource and server) or resource.is_paused:
            return
        await evaluate_server_samples(db, org, resource, server, samples)
        await events.commit(db)


async def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    await ensure_group()
    r = get_redis()
    buffer: list[tuple[str, dict[str, str]]] = []
    buffered_rows = 0
    last_flush = time.monotonic()
    last_claim = 0.0
    log.info("ingest consumer started", extra={"consumer": CONSUMER})
    while not stop.is_set() or buffer:
        try:
            if not stop.is_set():
                if time.monotonic() - last_claim > 30:
                    last_claim = time.monotonic()
                    claimed = await r.xautoclaim(STREAM, GROUP, CONSUMER, min_idle_time=60_000, start_id="0-0", count=500)
                    if claimed and claimed[1]:
                        buffer.extend(claimed[1])
                resp = await r.xreadgroup(GROUP, CONSUMER, {STREAM: ">"}, count=500, block=int(s.ingest_flush_seconds * 1000))
                for _, entries in resp or []:
                    for e in entries:
                        buffer.append(e)
                        buffered_rows += max(1, e[1].get("r", "").count('"ts"') + e[1].get("r", "").count('"scheduled_at"'))
            due = buffer and (buffered_rows >= s.ingest_batch_size or time.monotonic() - last_flush >= s.ingest_flush_seconds
                              or stop.is_set())
            if due:
                ids = await process_entries(buffer)
                if ids:
                    await r.xack(STREAM, GROUP, *ids)
                    await r.xdel(STREAM, *ids)
                buffer, buffered_rows, last_flush = [], 0, time.monotonic()
                await r.set(HEARTBEAT_KEY, datetime.now(UTC).isoformat(), ex=120)
        except Exception:
            log.exception("ingest iteration failed; backing off")
            buffer, buffered_rows = [], 0  # unacked entries will be reclaimed
            await asyncio.sleep(2)
    await dispose_engine()
    await close_redis()


if __name__ == "__main__":
    asyncio.run(main())
