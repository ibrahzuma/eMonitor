"""Database connectivity probes. Queries run inside read-only transactions."""

from __future__ import annotations

import asyncio
import ssl
from typing import Any

from app.models.enums import CheckOutcomeStatus
from app.monitoring.check_configs import DbConfig, DbSecrets, MysqlConfig, PostgresConfig, RedisConfig
from app.monitoring.probes.base import ProbeContext, ProbeResult, Timer
from app.monitoring.probes.net import _guarded_addrs
from app.monitoring.probes.tlsinfo import insecure_context


def _finish(cfg: DbConfig, elapsed: float, value: Any, label: str, details: dict[str, Any]) -> ProbeResult:
    if cfg.expected_value is not None and str(value) != cfg.expected_value:
        return ProbeResult.down(f"query returned {value!r}, expected {cfg.expected_value!r}", latency_ms=elapsed,
                                details=details)
    status = CheckOutcomeStatus.UP
    if cfg.latency_warning_ms and elapsed > cfg.latency_warning_ms:
        status = CheckOutcomeStatus.DEGRADED
    return ProbeResult(status, f"{label} responded in {elapsed:.0f} ms", latency_ms=elapsed, details=details,
                       metrics=[("db_latency_ms", "", elapsed)])


async def probe_postgres(cfg: PostgresConfig, ctx: ProbeContext) -> ProbeResult:
    import asyncpg

    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    secrets: DbSecrets | None = ctx.secrets
    ssl_arg: Any = False if cfg.tls == "disable" else (insecure_context() if cfg.tls == "require" else "prefer")
    t = Timer()
    conn = None
    try:
        conn = await asyncpg.connect(
            host=addrs[0], port=cfg.port, user=cfg.username, password=secrets.password if secrets else None,
            database=cfg.database, timeout=ctx.timeout, ssl=ssl_arg, command_timeout=ctx.timeout,
            server_settings={"application_name": "emonitor-probe", "default_transaction_read_only": "on"},
        )
        connect_ms = t.ms()
        async with conn.transaction(readonly=True):
            await conn.execute(f"SET LOCAL statement_timeout = {int(ctx.timeout * 1000)}")
            value = await conn.fetchval(cfg.query or "SELECT 1")
        version = conn.get_server_version()
    except TimeoutError:
        return ProbeResult.down("PostgreSQL connection timed out")
    except Exception as exc:  # asyncpg raises many types; surface the message
        return ProbeResult.down(f"PostgreSQL error: {exc}"[:500])
    finally:
        if conn is not None:
            await conn.close(timeout=2)
    details = {"server_version": f"{version.major}.{version.minor}", "connect_ms": connect_ms}
    return _finish(cfg, t.ms(), value, "PostgreSQL", details)


async def probe_mysql(cfg: MysqlConfig, ctx: ProbeContext) -> ProbeResult:
    import aiomysql

    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    secrets: DbSecrets | None = ctx.secrets
    t = Timer()
    conn = None
    try:
        conn = await asyncio.wait_for(
            aiomysql.connect(
                host=addrs[0], port=cfg.port, user=cfg.username or "", password=(secrets.password if secrets else "") or "",
                db=cfg.database, connect_timeout=ctx.timeout,
                ssl=insecure_context() if cfg.tls == "require" else None, autocommit=False,
            ),
            timeout=ctx.timeout,
        )
        connect_ms = t.ms()
        async with conn.cursor() as cur:
            await cur.execute("SET SESSION TRANSACTION READ ONLY")
            await cur.execute("START TRANSACTION READ ONLY")
            await cur.execute(cfg.query or "SELECT 1")
            row = await cur.fetchone()
            await cur.execute("SELECT VERSION()")
            ver = await cur.fetchone()
        await conn.rollback()
    except TimeoutError:
        return ProbeResult.down("MySQL connection timed out")
    except Exception as exc:
        return ProbeResult.down(f"MySQL error: {exc}"[:500])
    finally:
        if conn is not None:
            conn.close()
    value = row[0] if row else None
    return _finish(cfg, t.ms(), value, "MySQL", {"server_version": ver[0] if ver else None, "connect_ms": connect_ms})


async def probe_redis(cfg: RedisConfig, ctx: ProbeContext) -> ProbeResult:
    import redis.asyncio as aioredis

    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    secrets: DbSecrets | None = ctx.secrets
    t = Timer()
    kwargs: dict[str, Any] = {"ssl": True, "ssl_cert_reqs": ssl.CERT_NONE} if cfg.tls else {}
    client = aioredis.Redis(
        host=addrs[0], port=cfg.port, db=cfg.db, username=cfg.username, password=secrets.password if secrets else None,
        socket_timeout=ctx.timeout, socket_connect_timeout=ctx.timeout, **kwargs,
    )
    try:
        pong = await client.ping()
        elapsed = t.ms()
        info = await client.info(section="server")
        mem = await client.info(section="memory")
        clients = await client.info(section="clients")
    except TimeoutError:
        return ProbeResult.down("Redis connection timed out")
    except Exception as exc:
        return ProbeResult.down(f"Redis error: {exc}"[:500])
    finally:
        await client.aclose()
    if not pong:
        return ProbeResult.down("Redis did not answer PING")
    details = {
        "redis_version": info.get("redis_version"),
        "used_memory": mem.get("used_memory"),
        "connected_clients": clients.get("connected_clients"),
    }
    res = ProbeResult(CheckOutcomeStatus.UP, f"PONG in {elapsed:.0f} ms", latency_ms=elapsed, details=details,
                      metrics=[("db_latency_ms", "", elapsed)])
    if mem.get("used_memory") is not None:
        res.metrics.append(("redis_used_memory_bytes", "", float(mem["used_memory"])))
    if clients.get("connected_clients") is not None:
        res.metrics.append(("redis_connected_clients", "", float(clients["connected_clients"])))
    if cfg.latency_warning_ms and elapsed > cfg.latency_warning_ms:
        res.status = CheckOutcomeStatus.DEGRADED
    return res
