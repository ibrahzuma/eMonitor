"""Health endpoints, platform status, and the live-event WebSocket."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db, get_sessionmaker
from app.core.deps import Principal, authenticate_token, require_superadmin, resolve_ctx
from app.core.errors import ApiError
from app.core.events import channel_for
from app.core.permissions import Permission
from app.core.redis import get_redis
from app.models import NotificationDelivery
from app.telemetry.ingest import stream_length
from app.telemetry.store import get_store

router = APIRouter(tags=["system"])
log = logging.getLogger("emonitor.ws")


@router.get("/health/live")
async def live():
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(db: AsyncSession = Depends(get_db)):
    checks: dict[str, str] = {}
    try:
        await db.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception:
        checks["postgres"] = "error"
    try:
        await get_redis().ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "error"
    checks["clickhouse"] = "ok" if await get_store().ping() else "error"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"status": "ok" if ok else "degraded", "checks": checks}, status_code=200 if ok else 503)


@router.get("/system/status")
async def system_status(_: Principal = Depends(require_superadmin), db: AsyncSession = Depends(get_db)):
    r = get_redis()
    hb = {}
    queues = {}
    try:
        for name in ("scheduler", "ingest", "worker"):
            hb[name] = await r.get(f"emonitor:heartbeat:{name}")
        for q in ("checks", "notifications", "maintenance", "rules"):
            queues[q] = await r.llen(q)
    except Exception:
        hb, queues = {"error": "redis unavailable"}, {}
    pending = await db.scalar(select(func.count()).select_from(NotificationDelivery)
                              .where(NotificationDelivery.status == "pending"))
    failed_24h = await db.scalar(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "failed",
        NotificationDelivery.created_at >= func.now() - text("interval '24 hours'")))
    lag = None
    try:
        info = await r.xinfo_groups("emonitor:ingest")
        lag = [{"group": g.get("name"), "pending": g.get("pending"), "lag": g.get("lag")} for g in info]
    except Exception:
        pass
    try:
        storage = await get_store().storage_stats()
    except Exception:
        storage = []
    return {
        "time": datetime.now(UTC), "heartbeats": hb, "queue_depths": queues,
        "ingest_stream_length": await stream_length(), "ingest_groups": lag,
        "notifications": {"pending": pending or 0, "failed_24h": failed_24h or 0}, "clickhouse_storage": storage,
    }


@router.websocket("/ws")
async def websocket(ws: WebSocket):
    """Live events. First client message must be {"type":"auth","token":"...","organization_id":"..."}."""
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        await ws.close(code=4401)
        return
    if not isinstance(first, dict) or first.get("type") != "auth" or not first.get("token"):
        await ws.close(code=4401)
        return
    try:
        async with get_sessionmaker()() as db:
            principal = await authenticate_token(db, str(first["token"]))
            ctx = await resolve_ctx(db, principal, first.get("organization_id"))
    except ApiError:
        await ws.close(code=4401)
        return
    if Permission.VIEW not in ctx.permissions:
        await ws.close(code=4403)
        return
    org_id = ctx.org_id
    can_logs = Permission.LOGS_READ in ctx.permissions
    await ws.send_json({"type": "ready", "organization_id": str(org_id)})
    pubsub = get_redis().pubsub()
    try:
        await pubsub.subscribe(channel_for(org_id))
    except Exception:
        # Tell the client explicitly; it falls back to polling instead of reconnecting in a tight loop.
        await ws.send_json({"type": "error", "message": "live events unavailable"})
        await ws.close(code=1011)
        return
    log_filter: dict | None = None

    async def reader() -> None:
        nonlocal log_filter
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict) and msg.get("type") == "subscribe_logs" and can_logs:
                log_filter = {k: msg.get(k) for k in ("severity", "application", "host", "q") if msg.get(k)}
            elif isinstance(msg, dict) and msg.get("type") == "unsubscribe_logs":
                log_filter = None
            elif isinstance(msg, dict) and msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})

    async def writer() -> None:
        last_log_poll = datetime.now(UTC)
        while True:
            try:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            except Exception:
                await ws.send_json({"type": "error", "message": "live events unavailable"})
                await ws.close(code=1011)
                return
            if msg and msg.get("data"):
                try:
                    payload = json.loads(msg["data"])
                except ValueError:
                    continue
                if payload.get("type") == "logs":
                    if log_filter is None:
                        continue
                await ws.send_text(msg["data"])
            if log_filter is not None:
                now = datetime.now(UTC)
                if (now - last_log_poll).total_seconds() >= 2:
                    from app.telemetry.store import LogQuery

                    q = LogQuery(start=last_log_poll, end=now, text=log_filter.get("q", ""),
                                 severities=[log_filter["severity"]] if log_filter.get("severity") else [],
                                 applications=[log_filter["application"]] if log_filter.get("application") else [],
                                 hosts=[log_filter["host"]] if log_filter.get("host") else [])
                    try:
                        rows, _ = await get_store().search_logs(org_id, q, 200, None)
                    except Exception:
                        rows = []
                    last_log_poll = now
                    if rows:
                        await ws.send_text(json.dumps({"type": "log_tail", "data": rows[::-1]}, default=str))

    tasks = [asyncio.create_task(reader()), asyncio.create_task(writer())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        try:
            await pubsub.unsubscribe()
            await pubsub.aclose()
        except Exception:
            pass
