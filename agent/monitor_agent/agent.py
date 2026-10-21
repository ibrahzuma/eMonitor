"""Agent runtime: configuration, enrollment, collection loop, delivery with spool + backoff."""

from __future__ import annotations

import json
import logging
import os
import signal
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from monitor_agent import __version__
from monitor_agent.collectors import Collector, get_collector
from monitor_agent.logtail import LogTailer
from monitor_agent.spool import Spool
from monitor_agent.transport import Transport, TransportError, backoff_delay

log = logging.getLogger("emonitor-agent")

DEFAULT_CONFIG = "/etc/emonitor-agent/agent.json"
MIN_INTERVAL, MAX_INTERVAL = 10, 3600


@dataclass
class Config:
    server_url: str
    credentials_file: str = "/etc/emonitor-agent/credentials.json"
    state_dir: str = "/var/lib/emonitor-agent"
    ca_bundle: str | None = None
    interval_seconds: int = 30
    services: list[str] = field(default_factory=list)
    log_files: list[dict[str, Any]] = field(default_factory=list)
    spool_max_mb: int = 50
    rotate_credentials_days: int = 30
    allow_insecure_http: bool = False
    follow_server_interval: bool = True

    @classmethod
    def load(cls, path: str) -> Config:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        known = {k: v for k, v in raw.items() if k in cls.__dataclass_fields__}
        cfg = cls(**known)
        for lf in cfg.log_files:
            if not isinstance(lf, dict) or not str(lf.get("path", "")).startswith("/"):
                raise ValueError("log_files entries need an absolute 'path'")
        cfg.interval_seconds = max(MIN_INTERVAL, min(MAX_INTERVAL, int(cfg.interval_seconds)))
        return cfg


def read_credentials(path: str) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_credentials(path: str, creds: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(creds, fh)
    os.replace(tmp, p)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def primary_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # no packets are sent for UDP connect
            return s.getsockname()[0]
    except OSError:
        return ""


def enroll(cfg: Config, token: str, collector: Collector | None = None) -> dict[str, Any]:
    collector = collector or get_collector(cfg.services)
    info = collector.system_info()
    t = Transport(cfg.server_url, cfg.ca_bundle, allow_insecure_http=cfg.allow_insecure_http)
    body = {"token": token, "hostname": socket.getfqdn() or socket.gethostname(), "agent_version": __version__,
            "ip_address": primary_ip(), **{k: v for k, v in info.items() if k in
                                            ("os_version", "kernel", "cpu_count", "memory_total_bytes")}}
    resp = t.post("/agents/enroll", body)
    creds = {**resp, "enrolled_at": datetime.now(UTC).isoformat(), "rotated_at": datetime.now(UTC).isoformat()}
    write_credentials(cfg.credentials_file, creds)
    return creds


class Agent:
    def __init__(self, cfg: Config, collector: Collector | None = None, transport: Transport | None = None):
        self.cfg = cfg
        creds = read_credentials(cfg.credentials_file)
        if not creds or "agent_id" not in creds:
            raise SystemExit("agent is not enrolled; run: emonitor-agent enroll --server URL --token TOKEN")
        self.creds = creds
        self.collector = collector or get_collector(cfg.services)
        self.transport = transport or Transport(cfg.server_url, cfg.ca_bundle,
                                                allow_insecure_http=cfg.allow_insecure_http)
        state = Path(cfg.state_dir)
        state.mkdir(parents=True, exist_ok=True)
        self.spool = Spool(state / "spool", max_bytes=cfg.spool_max_mb * 2**20)
        self.tailer = LogTailer(cfg.log_files, state / "logtail.json") if cfg.log_files else None
        self.interval = cfg.interval_seconds
        self.stop = threading.Event()
        self.failures = 0
        self.next_flush_at = 0.0
        self.last_error = ""

    @property
    def auth(self) -> str:
        return f"Agent {self.creds['agent_id']}.{self.creds['agent_secret']}"

    def _send(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        path = {"metrics": "/agents/metrics", "logs": "/agents/logs", "heartbeat": "/agents/heartbeat"}[kind]
        return self.transport.post(path, payload, self.auth)

    def _apply_ack(self, ack: dict[str, Any]) -> None:
        iv = ack.get("collection_interval_seconds")
        if self.cfg.follow_server_interval and isinstance(iv, int):
            self.interval = max(MIN_INTERVAL, min(MAX_INTERVAL, iv))

    def deliver(self, kind: str, payload: dict[str, Any]) -> bool:
        """Send now if healthy, otherwise spool. Returns True when delivered."""
        if self.failures and time.monotonic() < self.next_flush_at:
            self.spool.push(kind, payload)
            return False
        try:
            self._apply_ack(self._send(kind, payload))
            self._ok()
            return True
        except TransportError as exc:
            if exc.status == 422:
                log.error("server rejected %s payload as invalid; dropping: %s", kind, exc)
                return False
            self.spool.push(kind, payload)
            self._fail(exc)
            return False

    def _ok(self) -> None:
        if self.failures:
            log.info("connection to server restored")
        self.failures = 0
        self.last_error = ""

    def _fail(self, exc: TransportError) -> None:
        self.failures += 1
        delay = exc.retry_after if exc.retry_after else backoff_delay(self.failures)
        if exc.fatal:
            delay = max(delay, 300.0)
        self.next_flush_at = time.monotonic() + delay
        self.last_error = str(exc)[:500]
        log.warning("delivery failed (%s); retrying in %.0fs; spool depth %d", exc, delay, self.spool.depth())

    def flush_spool(self, max_batches: int = 20) -> int:
        if time.monotonic() < self.next_flush_at:
            return 0
        sent = 0
        for path, kind, payload in self.spool.peek(max_batches):
            try:
                self._apply_ack(self._send(kind, payload))
            except TransportError as exc:
                if exc.status == 422:
                    log.error("dropping spooled %s batch rejected by server: %s", kind, exc)
                    self.spool.ack(path)
                    continue
                self._fail(exc)
                break
            self.spool.ack(path)
            sent += 1
            self._ok()
        return sent

    def maybe_rotate(self) -> None:
        days = self.cfg.rotate_credentials_days
        if days <= 0 or self.failures:
            return
        try:
            last = datetime.fromisoformat(self.creds.get("rotated_at") or self.creds["enrolled_at"])
        except (KeyError, ValueError):
            last = datetime.now(UTC)
        if datetime.now(UTC) - last < timedelta(days=days):
            return
        try:
            resp = self.transport.post("/agents/rotate", {}, self.auth)
        except TransportError as exc:
            log.warning("credential rotation failed: %s", exc)
            return
        self.creds = {**self.creds, "agent_secret": resp["agent_secret"], "rotated_at": datetime.now(UTC).isoformat()}
        write_credentials(self.cfg.credentials_file, self.creds)
        log.info("agent credentials rotated")

    def cycle(self) -> None:
        metrics = self.collector.collect()
        info = self.collector.system_info()
        payload = {
            "agent_version": __version__, "hostname": socket.gethostname(),
            "system": {k: v for k, v in info.items() if k in ("os_version", "kernel", "cpu_count", "memory_total_bytes",
                                                                "uptime_seconds")},
            "samples": [{"ts": datetime.now(UTC).isoformat(),
                         "metrics": [{"m": m, "i": i, "v": v} for m, i, v in metrics]}],
            "spool_depth": self.spool.depth(), "last_error": self.last_error,
        }
        delivered = self.deliver("metrics", payload)
        if self.tailer:
            records = self.tailer.poll()
            for i in range(0, len(records), 1000):
                self.deliver("logs", {"records": records[i:i + 1000]})
            self.tailer.save()
        if delivered:
            self.flush_spool()
        self.maybe_rotate()

    def run(self) -> None:
        log.info("emonitor-agent %s started (interval %ss, server %s)", __version__, self.interval, self.cfg.server_url)
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, lambda *_: self.stop.set())
            except ValueError:
                pass
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                self.cycle()
            except Exception:
                log.exception("collection cycle failed")
            if self.failures and self.spool.depth():
                self.flush_spool()
            self.stop.wait(max(1.0, self.interval - (time.monotonic() - started)))
        if self.tailer:
            self.tailer.save()
        log.info("emonitor-agent stopped (spool depth %d)", self.spool.depth())
