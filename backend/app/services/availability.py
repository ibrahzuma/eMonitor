"""Availability, SLO and error-budget calculations (documented in docs/METRICS.md)."""

from __future__ import annotations

import math
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Check, Organization, Resource, Slo
from app.models.enums import IncidentSource, Severity
from app.telemetry.store import get_store


@dataclass
class Availability:
    expected: int
    up: int
    degraded: int
    down: int
    unknown: int  # explicit unknown + skipped + never-executed slots
    maintenance: int
    uptime_percent: float | None  # None when no known samples
    coverage_percent: float
    downtime_seconds: float
    avg_ms: float | None = None
    min_ms: float | None = None
    max_ms: float | None = None
    p50_ms: float | None = None
    p95_ms: float | None = None
    p99_ms: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def expected_slots(start: datetime, end: datetime, interval: int, created_at: datetime | None = None) -> int:
    """Slots the scheduler should have executed in [start, end) — not counting before creation."""
    if created_at and created_at > start:
        start = created_at
    if end <= start:
        return 0
    return max(0, math.floor((end - start).total_seconds() / max(1, interval)))


def compute_availability(stats: dict[str, Any] | None, expected: int, interval: int) -> Availability:
    s = stats or {}
    up, degraded, down = int(s.get("up", 0)), int(s.get("degraded", 0)), int(s.get("down", 0))
    explicit_unknown = int(s.get("unknown", 0)) + int(s.get("skipped", 0))
    maint = int(s.get("maintenance", 0))
    observed = up + degraded + down + explicit_unknown + maint
    missing = max(0, expected - observed)  # slots with no record at all → unknown, never "up"
    unknown = explicit_unknown + missing
    known = up + degraded + down
    total = max(expected, observed)
    uptime = round((up + degraded) / known * 100, 4) if known else None
    coverage = round((known + maint) / total * 100, 2) if total else 0.0
    return Availability(
        expected=total, up=up, degraded=degraded, down=down, unknown=unknown, maintenance=maint,
        uptime_percent=uptime, coverage_percent=coverage, downtime_seconds=float(down * interval),
        avg_ms=s.get("avg_ms"), min_ms=s.get("min_ms"), max_ms=s.get("max_ms"), p50_ms=s.get("p50_ms"),
        p95_ms=s.get("p95_ms"), p99_ms=s.get("p99_ms"),
    )


async def check_availability(org_id: uuid.UUID, checks: list[Check], start: datetime,
                             end: datetime) -> dict[uuid.UUID, Availability]:
    stats = await get_store().check_stats(org_id, [c.id for c in checks], start, end)
    return {
        c.id: compute_availability(stats.get(c.id), expected_slots(start, end, c.interval_seconds, c.created_at),
                                   c.interval_seconds)
        for c in checks
    }


def combine(avails: list[Availability]) -> Availability | None:
    """Resource-level availability: aggregate slot counts across its checks."""
    if not avails:
        return None
    up = sum(a.up for a in avails)
    deg = sum(a.degraded for a in avails)
    down = sum(a.down for a in avails)
    known = up + deg + down
    total = sum(a.expected for a in avails)
    maint = sum(a.maintenance for a in avails)
    return Availability(
        expected=total, up=up, degraded=deg, down=down, unknown=sum(a.unknown for a in avails), maintenance=maint,
        uptime_percent=round((up + deg) / known * 100, 4) if known else None,
        coverage_percent=round((known + maint) / total * 100, 2) if total else 0.0,
        downtime_seconds=max((a.downtime_seconds for a in avails), default=0.0),
        avg_ms=_avg([a.avg_ms for a in avails]), p95_ms=max((a.p95_ms for a in avails if a.p95_ms is not None), default=None),
    )


def _avg(values: list[float | None]) -> float | None:
    v = [x for x in values if x is not None]
    return sum(v) / len(v) if v else None


@dataclass
class SloStatus:
    target_percent: float
    window_days: int
    sli_percent: float | None
    error_budget_total: float  # fraction of bad events allowed (e.g. 0.001)
    error_budget_remaining_percent: float | None
    bad_events: int
    good_events: int
    burn_rate_1h: float | None
    burn_rate_6h: float | None
    status: str  # ok | at_risk | breached | no_data

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def burn_rate(good: int, bad: int, target_percent: float) -> float | None:
    total = good + bad
    if total == 0:
        return None
    allowed = 1 - target_percent / 100
    if allowed <= 0:
        return math.inf if bad else 0.0
    return (bad / total) / allowed


def slo_status(window: Availability, short: Availability, longer: Availability, target: float, window_days: int,
               fast: float, slow: float) -> SloStatus:
    good = window.up + window.degraded
    bad = window.down
    allowed = 1 - target / 100
    total = good + bad
    sli = round(good / total * 100, 4) if total else None
    remaining = None
    if total:
        budget_events = allowed * total
        remaining = round((1 - bad / budget_events) * 100, 2) if budget_events > 0 else (100.0 if bad == 0 else -100.0)
    br1 = burn_rate(short.up + short.degraded, short.down, target)
    br6 = burn_rate(longer.up + longer.degraded, longer.down, target)
    if sli is None:
        status = "no_data"
    elif sli < target:
        status = "breached"
    elif (br1 is not None and br1 >= fast) or (br6 is not None and br6 >= slow) or (remaining is not None and remaining < 25):
        status = "at_risk"
    else:
        status = "ok"
    return SloStatus(target, window_days, sli, allowed, remaining, bad, good, br1, br6, status)


async def compute_slo(db: AsyncSession, slo: Slo, now: datetime | None = None) -> SloStatus:
    now = now or datetime.now(UTC)
    if slo.check_id:
        checks = list((await db.scalars(select(Check).where(Check.id == slo.check_id))).all())
    else:
        checks = list((await db.scalars(select(Check).where(Check.resource_id == slo.resource_id,
                                                            Check.enabled.is_(True)))).all())

    async def _agg(start: datetime) -> Availability:
        av = await check_availability(slo.organization_id, checks, start, now)
        return combine(list(av.values())) or compute_availability({}, 0, 60)

    window = await _agg(now - timedelta(days=slo.window_days))
    short = await _agg(now - timedelta(hours=1))
    longer = await _agg(now - timedelta(hours=6))
    return slo_status(window, short, longer, slo.target_percent, slo.window_days, slo.fast_burn_threshold,
                      slo.slow_burn_threshold)


async def evaluate_slo(db: AsyncSession, slo: Slo, now: datetime | None = None) -> SloStatus:
    from app.incidents import engine

    now = now or datetime.now(UTC)
    status = await compute_slo(db, slo, now)
    slo.last_evaluated_at = now
    slo.last_status = status.as_dict()
    if not slo.burn_rate_alerts:
        return status
    org = await db.get(Organization, slo.organization_id)
    resource = await db.get(Resource, slo.resource_id)
    dedup = f"slo:{slo.id}"
    fast = status.burn_rate_1h is not None and status.burn_rate_1h >= slo.fast_burn_threshold
    slow = status.burn_rate_6h is not None and status.burn_rate_6h >= slo.slow_burn_threshold
    if org and (fast or slow or status.status == "breached"):
        sev = Severity.CRITICAL if fast or status.status == "breached" else Severity.WARNING
        await engine.raise_condition(
            db, org=org, dedup_key=dedup, title=f"SLO '{slo.name}' error budget burning",
            severity=sev, source=IncidentSource.SLO, source_id=str(slo.id), resource=resource,
            trigger_condition=(f"burn rate 1h={_fmt(status.burn_rate_1h)} (>= {slo.fast_burn_threshold}), "
                               f"6h={_fmt(status.burn_rate_6h)} (>= {slo.slow_burn_threshold}); "
                               f"SLI {_fmt(status.sli_percent)}% vs target {slo.target_percent}%"),
            evidence={"slo": status.as_dict()}, notification_policy_id=slo.notification_policy_id,
            renotify_marker=sev.value, now=now)
    elif org:
        await engine.clear_condition(db, org_id=org.id, dedup_key=dedup, message="SLO burn rate back within limits",
                                     now=now)
    return status


def _fmt(v: float | None) -> str:
    return "n/a" if v is None else f"{v:.2f}"
