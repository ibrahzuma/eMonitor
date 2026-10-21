from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from app.models.enums import CheckOutcomeStatus
from app.monitoring.netguard import Scope


@dataclass
class ProbeContext:
    scope: Scope
    timeout: float
    secrets: Any = None  # parsed secrets model, if any
    previous: dict[str, Any] = field(default_factory=dict)  # last_details of the check (e.g. SNMP counters)


@dataclass
class ProbeResult:
    status: CheckOutcomeStatus
    message: str = ""
    latency_ms: float | None = None
    dns_ms: float | None = None
    connect_ms: float | None = None
    tls_ms: float | None = None
    ttfb_ms: float | None = None
    http_status: int = 0
    details: dict[str, Any] = field(default_factory=dict)
    # Numeric samples to store as metrics for the check's resource (metric, instance, value)
    metrics: list[tuple[str, str, float]] = field(default_factory=list)

    @classmethod
    def down(cls, message: str, **kw: Any) -> ProbeResult:
        return cls(CheckOutcomeStatus.DOWN, message, **kw)

    @classmethod
    def unknown(cls, message: str, **kw: Any) -> ProbeResult:
        return cls(CheckOutcomeStatus.UNKNOWN, message, **kw)


class Timer:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()

    def ms(self) -> float:
        return round((time.perf_counter() - self.t0) * 1000, 2)
