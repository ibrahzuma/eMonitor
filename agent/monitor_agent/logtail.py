"""Tail allowlisted log files (configured locally), surviving rotation and truncation."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_SEV = re.compile(r"\b(EMERG|ALERT|CRIT(?:ICAL)?|FATAL|ERR(?:OR)?|WARN(?:ING)?|NOTICE|INFO|DEBUG|TRACE)\b", re.I)
_SEV_MAP = {"EMERG": "emergency", "ALERT": "alert", "CRIT": "critical", "CRITICAL": "critical", "FATAL": "critical",
            "ERR": "error", "ERROR": "error", "WARN": "warning", "WARNING": "warning", "NOTICE": "notice",
            "INFO": "info", "DEBUG": "debug", "TRACE": "debug"}
MAX_LINE = 16_384


def guess_severity(line: str, default: str = "info") -> str:
    m = _SEV.search(line[:300])
    return _SEV_MAP.get(m.group(1).upper(), default) if m else default


def to_record(line: str, source: dict[str, Any]) -> dict[str, Any]:
    rec: dict[str, Any] = {"message": line[:MAX_LINE], "source": source.get("source", source["path"])[:128],
                           "application": source.get("application", "")[:128],
                           "service": source.get("service", "")[:128]}
    if source.get("format") == "json":
        try:
            doc = json.loads(line)
            if isinstance(doc, dict):
                rec["message"] = str(doc.get("message") or doc.get("msg") or line)[:MAX_LINE]
                lvl = str(doc.get("level") or doc.get("severity") or "")
                rec["severity"] = _SEV_MAP.get(lvl.upper(), lvl.lower() or "info")
                if doc.get("trace_id") or doc.get("traceId"):
                    rec["trace_id"] = str(doc.get("trace_id") or doc.get("traceId"))[:128]
                ts = doc.get("timestamp") or doc.get("time") or doc.get("ts")
                if isinstance(ts, str):
                    rec["ts"] = ts
                rec["attributes"] = {k: str(v)[:1024] for k, v in list(doc.items())[:50]
                                     if k not in ("message", "msg", "level", "severity", "timestamp", "time", "ts",
                                                              "trace_id", "traceId")}
                return rec
        except ValueError:
            pass
    rec["severity"] = guess_severity(line, source.get("default_severity", "info"))
    return rec


@dataclass
class TailState:
    inode: int
    offset: int


@dataclass
class LogTailer:
    sources: list[dict[str, Any]]
    state_file: Path
    max_lines_per_poll: int = 2000
    state: dict[str, TailState] = field(default_factory=dict)

    def __post_init__(self) -> None:
        try:
            raw = json.loads(self.state_file.read_text(encoding="utf-8"))
            self.state = {k: TailState(**v) for k, v in raw.items()}
        except (OSError, ValueError, TypeError):
            self.state = {}

    def save(self) -> None:
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({k: vars(v) for k, v in self.state.items()}), encoding="utf-8")
        os.replace(tmp, self.state_file)

    def poll(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for src in self.sources:
            path = src["path"]
            try:
                st = os.stat(path)
            except OSError:
                continue
            prev = self.state.get(path)
            if prev is None:
                # Start at the end of existing files: don't flood with historical content.
                self.state[path] = TailState(st.st_ino, st.st_size if src.get("from_start") is not True else 0)
                prev = self.state[path]
            if prev.inode != st.st_ino or st.st_size < prev.offset:  # rotated or truncated
                prev.inode, prev.offset = st.st_ino, 0
            if st.st_size == prev.offset:
                continue
            with open(path, "rb") as fh:
                fh.seek(prev.offset)
                n = 0
                while n < self.max_lines_per_poll:
                    line = fh.readline()
                    if not line or not line.endswith(b"\n"):
                        break  # partial line: wait for the rest
                    prev.offset += len(line)
                    text = line.decode("utf-8", errors="replace").rstrip("\r\n")
                    if text.strip():
                        rec = to_record(text, src)
                        rec.setdefault("ts", datetime.now(UTC).isoformat())
                        records.append(rec)
                    n += 1
        return records
