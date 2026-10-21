"""HTTPS transport to the eMonitor API (urllib, TLS verified)."""

from __future__ import annotations

import json
import random
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from monitor_agent import __version__


class TransportError(Exception):
    def __init__(self, message: str, status: int | None = None, retry_after: float | None = None,
                 fatal: bool = False):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.fatal = fatal  # e.g. 401: credentials revoked → stop retrying the same payload forever


@dataclass
class Transport:
    base_url: str
    ca_bundle: str | None = None
    timeout: float = 15.0
    allow_insecure_http: bool = False  # tests/dev only

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        if not self.base_url.startswith("https://") and not self.allow_insecure_http:
            raise ValueError("server URL must use https://")
        self._ctx = ssl.create_default_context(cafile=self.ca_bundle) if self.ca_bundle else ssl.create_default_context()

    def post(self, path: str, body: dict[str, Any], auth: str | None = None) -> dict[str, Any]:
        data = json.dumps(body, separators=(",", ":")).encode()
        req = urllib.request.Request(f"{self.base_url}/api/v1{path}", data=data, method="POST", headers={
            "Content-Type": "application/json", "User-Agent": f"emonitor-agent/{__version__}",
            **({"Authorization": auth} if auth else {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout,
                                        context=self._ctx if self.base_url.startswith("https") else None) as resp:
                raw = resp.read(1_000_000)
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            retry = exc.headers.get("Retry-After") if exc.headers else None
            detail = ""
            try:
                detail = json.loads(exc.read(10_000)).get("error", {}).get("message", "")
            except Exception:
                pass
            raise TransportError(f"HTTP {exc.code}: {detail}".strip(), status=exc.code,
                                 retry_after=float(retry) if retry and retry.isdigit() else None,
                                 fatal=exc.code in (401, 403)) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise TransportError(f"connection error: {getattr(exc, 'reason', exc)}") from None


def backoff_delay(attempt: int, base: float = 2.0, cap: float = 300.0) -> float:
    """Exponential backoff with full jitter."""
    return random.uniform(0, min(cap, base * 2 ** max(0, attempt)))
