"""emonitor-syslog: controlled syslog collector (UDP and TCP, RFC 3164 and RFC 5424).

Only messages from **registered sources** are accepted: a source IP must equal the `ip_address`
of a server, or be listed in a resource's `attributes.syslog_sources` (e.g. a firewall's management
IP). Messages from unknown senders are counted and dropped, so the collector cannot be used to
inject logs into arbitrary tenants. The source→resource map is refreshed from PostgreSQL every
60 s. Records are written through the normal ingest stream (with backpressure and quotas).

Run: `python -m app.workers.syslog_collector` (bind address/ports via EMONITOR_SYSLOG_* env vars).
Binding to port 514 requires CAP_NET_BIND_SERVICE (granted in the systemd unit).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import signal
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import dispose_engine, get_sessionmaker
from app.core.logging import configure_logging
from app.core.redis import close_redis
from app.telemetry.store import SEVERITY_NUM

log = logging.getLogger("emonitor.syslog")
_SEVERITIES = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"]
_RFC5424 = re.compile(r"^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[.*?\])\s?(.*)$", re.S)
_RFC3164 = re.compile(r"^<(\d{1,3})>([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}) (\S+) ([^:\[\s]+)(?:\[(\d+)\])?:? ?(.*)$",
                      re.S)
_PRI_ONLY = re.compile(r"^<(\d{1,3})>(.*)$", re.S)
MAX_MESSAGE = 16_384


@dataclass
class Source:
    org_id: uuid.UUID
    resource_id: uuid.UUID
    host: str
    environment: str
    retention_days: int


def parse_syslog(raw: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    raw = raw.rstrip("\r\n\x00")
    m = _RFC5424.match(raw)
    if m:
        pri = int(m.group(1))
        ts = now
        if m.group(2) != "-":
            try:
                ts = datetime.fromisoformat(m.group(2).replace("Z", "+00:00"))
            except ValueError:
                pass
        return {"severity": _SEVERITIES[pri % 8], "facility": pri // 8, "ts": ts, "host": _nil(m.group(3)),
                "application": _nil(m.group(4)), "attributes": {"procid": _nil(m.group(5)), "msgid": _nil(m.group(6)),
                                                                "structured_data": _nil(m.group(7))},
                "message": m.group(8).lstrip("﻿")}
    m = _RFC3164.match(raw)
    if m:
        pri = int(m.group(1))
        ts = now
        try:
            ts = datetime.strptime(f"{now.year} {m.group(2)}", "%Y %b %d %H:%M:%S").replace(tzinfo=UTC)
        except ValueError:
            pass
        return {"severity": _SEVERITIES[pri % 8], "facility": pri // 8, "ts": ts, "host": m.group(3),
                "application": m.group(4), "attributes": {"procid": m.group(5) or ""}, "message": m.group(6)}
    m = _PRI_ONLY.match(raw)
    if m:
        pri = int(m.group(1))
        return {"severity": _SEVERITIES[pri % 8], "facility": pri // 8, "ts": now, "host": "", "application": "",
                "attributes": {}, "message": m.group(2)}
    return {"severity": "notice", "facility": 1, "ts": now, "host": "", "application": "", "attributes": {},
            "message": raw}


def _nil(v: str) -> str:
    return "" if v == "-" else v


class Collector:
    def __init__(self) -> None:
        self.sources: dict[str, Source] = {}
        self.queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue(maxsize=50_000)
        self.dropped_unknown = 0
        self.dropped_overflow = 0

    async def refresh_sources(self) -> None:
        from app.models import Organization, Resource, ServerDetail

        out: dict[str, Source] = {}
        async with get_sessionmaker()() as db:
            orgs = {o.id: o for o in (await db.scalars(select(Organization).where(Organization.is_active.is_(True)))).all()}
            rows = (await db.execute(select(Resource, ServerDetail.ip_address).outerjoin(
                ServerDetail, ServerDetail.resource_id == Resource.id))).all()
            for r, ip in rows:
                org = orgs.get(r.organization_id)
                if not org:
                    continue
                ret = int((org.settings or {}).get("log_retention_days", 14))
                ips = [ip] if ip else []
                ips += [str(x) for x in (r.attributes or {}).get("syslog_sources", []) or []]
                for addr in ips:
                    if addr and addr not in out:  # first registration wins; duplicates across tenants are ignored
                        out[addr] = Source(r.organization_id, r.id, r.name, r.environment, ret)
        self.sources = out
        log.info("syslog sources refreshed", extra={"count": len(out)})

    def offer(self, peer_ip: str, line: str) -> None:
        if peer_ip not in self.sources:
            self.dropped_unknown += 1
            return
        try:
            self.queue.put_nowait((peer_ip, line[:MAX_MESSAGE * 2]))
        except asyncio.QueueFull:
            self.dropped_overflow += 1

    def to_row(self, peer_ip: str, line: str) -> dict[str, Any] | None:
        src = self.sources.get(peer_ip)
        if src is None:
            return None
        p = parse_syslog(line)
        return {
            "ts": p["ts"], "id": uuid.uuid4(), "org_id": src.org_id, "resource_id": src.resource_id,
            "host": (p["host"] or src.host)[:255], "application": p["application"][:128], "service": "",
            "source": "syslog", "environment": src.environment, "severity": p["severity"],
            "severity_num": SEVERITY_NUM[p["severity"]], "message": p["message"][:MAX_MESSAGE], "trace_id": "",
            "attributes": {k: str(v)[:1024] for k, v in {**p["attributes"], "facility": p["facility"],
                                                          "peer": peer_ip}.items() if v not in (None, "")},
            "retention_days": src.retention_days,
        }

    async def writer(self, stop: asyncio.Event) -> None:
        from app.core.errors import ServiceUnavailable
        from app.telemetry.ingest import publish_rows

        while not stop.is_set() or not self.queue.empty():
            batch: list[dict[str, Any]] = []
            try:
                item = await asyncio.wait_for(self.queue.get(), timeout=1.0)
                row = self.to_row(*item)
                if row:
                    batch.append(row)
                while len(batch) < 2000 and not self.queue.empty():
                    row = self.to_row(*self.queue.get_nowait())
                    if row:
                        batch.append(row)
            except TimeoutError:
                continue
            if batch:
                for attempt in range(5):
                    try:
                        await publish_rows("logs", batch)
                        break
                    except ServiceUnavailable:
                        await asyncio.sleep(2 ** attempt)
                    except Exception:
                        log.exception("failed to publish syslog batch")
                        await asyncio.sleep(2)


class _Udp(asyncio.DatagramProtocol):
    def __init__(self, c: Collector):
        self.c = c

    def datagram_received(self, data: bytes, addr: Any) -> None:
        self.c.offer(addr[0], data.decode("utf-8", errors="replace"))


async def main() -> None:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    host = os.environ.get("EMONITOR_SYSLOG_BIND", "0.0.0.0")  # noqa: S104 (dedicated listener)
    udp_port = int(os.environ.get("EMONITOR_SYSLOG_UDP_PORT", "514"))
    tcp_port = int(os.environ.get("EMONITOR_SYSLOG_TCP_PORT", "514"))
    c = Collector()
    await c.refresh_sources()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    transport, _ = await loop.create_datagram_endpoint(lambda: _Udp(c), local_addr=(host, udp_port))

    async def tcp_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")[0]
        if peer not in c.sources:
            c.dropped_unknown += 1
            writer.close()
            return
        try:
            while not stop.is_set():
                line = await asyncio.wait_for(reader.readline(), timeout=300)
                if not line:
                    break
                c.offer(peer, line.decode("utf-8", errors="replace"))
        except (TimeoutError, ConnectionError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(tcp_client, host, tcp_port, limit=MAX_MESSAGE * 2)
    w = asyncio.create_task(c.writer(stop))

    async def refresher() -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=60)
            except TimeoutError:
                try:
                    await c.refresh_sources()
                except Exception:
                    log.exception("source refresh failed")
                if c.dropped_unknown or c.dropped_overflow:
                    log.warning("syslog messages dropped", extra={"unknown_source": c.dropped_unknown,
                                                                  "overflow": c.dropped_overflow})

    r = asyncio.create_task(refresher())
    log.info("syslog collector listening", extra={"udp": udp_port, "tcp": tcp_port})
    await stop.wait()
    transport.close()
    server.close()
    await asyncio.gather(w, r, return_exceptions=True)
    await dispose_engine()
    await close_redis()


if __name__ == "__main__":
    asyncio.run(main())
