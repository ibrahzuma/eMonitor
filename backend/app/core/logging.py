"""Structured JSON logging with request correlation and secret redaction."""

from __future__ import annotations

import contextvars
import json
import logging
import re
import sys
from datetime import UTC, datetime

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")

_REDACT_PATTERNS = [
    re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key|authorization|community|private[_-]?key)"
               r"(\"?\s*[:=]\s*\"?)([^\s\",}]+)"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*"),
    re.compile(r"emk_[0-9a-f]{12}_[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)(agent\s+)[0-9a-f\-]{36}\.[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)(://[^:/\s]+:)[^@/\s]+(@)"),  # credentials in URLs
]


def redact(text: str) -> str:
    for pat in _REDACT_PATTERNS:
        if pat.groups >= 3:
            text = pat.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", text)
        elif pat.groups == 2:
            text = pat.sub(lambda m: f"{m.group(1)}[REDACTED]{m.group(2)}", text)
        elif pat.groups == 1:
            text = pat.sub(lambda m: f"{m.group(1)}[REDACTED]", text)
        else:
            text = pat.sub("[REDACTED]", text)
    return text


class JsonFormatter(logging.Formatter):
    _std = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime"}

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        rid = request_id_var.get()
        if rid:
            payload["request_id"] = rid
        for k, v in record.__dict__.items():
            if k not in self._std and not k.startswith("_"):
                payload[k] = redact(str(v)) if isinstance(v, str) else v
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, default=str)


class RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def configure_logging(level: str = "INFO", json_logs: bool = True) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter() if json_logs else RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for noisy in ("uvicorn.access", "httpx", "asyncio"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
