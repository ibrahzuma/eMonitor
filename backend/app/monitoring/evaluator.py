"""State evaluation: check outcomes, server metric thresholds, agent liveness, resource health."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.incidents import engine
from app.models import Agent, Check, MetricState, Organization, Resource, ServerDetail
from app.models.enums import (
    HEALTH_RANK,
    AgentStatus,
    CheckOutcomeStatus,
    CheckType,
    HealthStatus,
    IncidentSource,
    ResourceKind,
    Severity,
)
from app.monitoring.probes.base import ProbeResult
from app.services import maintenance
from app.telemetry.ingest import publish_rows

log = logging.getLogger("emonitor.evaluator")

DEFAULT_SSL_DAYS = [30, 14, 7, 3, 0]
SEVERITY_TO_HEALTH = {
    Severity.CRITICAL: HealthStatus.CRITICAL,
    Severity.HIGH: HealthStatus.CRITICAL,
    Severity.WARNING: HealthStatus.WARNING,
    Severity.INFO: HealthStatus.WARNING,
}
REACHABILITY_TYPES = {CheckType.ICMP}


def _now() -> datetime:
    return datetime.now(UTC)


def failing_health(check: Check, resource: Resource) -> HealthStatus:
    if check.type in REACHABILITY_TYPES or (resource.kind == ResourceKind.SERVER and check.type == CheckType.TCP
                                              and check.config.get("port") == 22):
        return HealthStatus.UNREACHABLE
    return SEVERITY_TO_HEALTH.get(Severity(check.severity), HealthStatus.CRITICAL)


def next_check_state(check: Check, outcome: CheckOutcomeStatus, resource: Resource) -> HealthStatus:
    """Pure state machine for a check given updated consecutive counters."""
    current = HealthStatus(check.state) if check.state in HealthStatus._value2member_map_ else HealthStatus.UNKNOWN
    failing = current in (HealthStatus.CRITICAL, HealthStatus.UNREACHABLE) or (
        current == HealthStatus.WARNING and check.consecutive_failures > 0)
    if outcome == CheckOutcomeStatus.DOWN:
        if check.consecutive_failures >= max(1, check.failure_threshold):
            return failing_health(check, resource)
        return current
    if outcome in (CheckOutcomeStatus.UP, CheckOutcomeStatus.DEGRADED):
        target = HealthStatus.HEALTHY if outcome == CheckOutcomeStatus.UP else HealthStatus.WARNING
        if failing and check.consecutive_successes < max(1, check.recovery_threshold):
            return current
        return target
    return current  # UNKNOWN/SKIPPED outcomes never change state


def ssl_threshold(days_remaining: int, thresholds: list[int]) -> int | None:
    """Return the smallest configured threshold that the remaining days have crossed."""
    crossed = [t for t in sorted(set(thresholds)) if days_remaining <= t]
    return crossed[0] if crossed else None


def ssl_severity(threshold: int) -> Severity:
    if threshold <= 0:
        return Severity.CRITICAL
    if threshold <= 3:
        return Severity.CRITICAL
    if threshold <= 7:
        return Severity.HIGH
    return Severity.WARNING


async def process_check_result(db: AsyncSession, check_id: uuid.UUID, slot: datetime, result: ProbeResult,
                               *, worker: str = "", now: datetime | None = None) -> dict[str, Any]:
    """Apply one probe result. Idempotent per (check, slot). Caller commits via events.commit()."""
    now = now or _now()
    check = await db.scalar(select(Check).where(Check.id == check_id).with_for_update())
    if check is None:
        return {"ignored": "check deleted"}
    if check.last_slot is not None and slot <= check.last_slot:
        return {"ignored": "duplicate or stale slot"}
    resource = await db.get(Resource, check.resource_id)
    org = await db.get(Organization, check.organization_id)
    assert resource is not None and org is not None
    windows = await maintenance.windows_for_resource(db, resource, org.id, now)
    in_maint = bool(windows)

    # 1) raw measurement → ClickHouse (never dropped, even in maintenance)
    row = {
        "scheduled_at": slot, "executed_at": now, "org_id": org.id, "check_id": check.id, "resource_id": resource.id,
        "check_type": check.type, "status": result.status.value, "latency_ms": result.latency_ms,
        "dns_ms": result.dns_ms, "connect_ms": result.connect_ms, "tls_ms": result.tls_ms, "ttfb_ms": result.ttfb_ms,
        "http_status": result.http_status, "message": result.message[:1000],
        "details": json.dumps(_trim_details(result.details), default=str), "in_maintenance": 1 if in_maint else 0,
        "worker": worker,
    }
    metric_rows = [
        {"ts": now, "org_id": org.id, "resource_id": resource.id, "metric": m, "instance": inst, "value": v,
         "source": f"check:{check.type}", "retention_days": int((org.settings or {}).get("metric_retention_days", 90))}
        for m, inst, v in result.metrics
    ]
    if result.latency_ms is not None:
        metric_rows.append({"ts": now, "org_id": org.id, "resource_id": resource.id, "metric": "response_time_ms",
                            "instance": check.name[:60], "value": result.latency_ms, "source": f"check:{check.type}"})

    async def _write() -> None:
        await publish_rows("check_results", [row], enforce_backpressure=False)
        await publish_rows("metrics", metric_rows, enforce_backpressure=False)

    events.defer(db, _write)

    # 2) counters + state machine
    outcome = result.status
    if outcome in (CheckOutcomeStatus.UP, CheckOutcomeStatus.DEGRADED):
        check.consecutive_successes += 1
        check.consecutive_failures = 0
    elif outcome == CheckOutcomeStatus.DOWN:
        check.consecutive_failures += 1
        check.consecutive_successes = 0
    prev_state = check.state
    new_state = next_check_state(check, outcome, resource)
    check.last_slot = slot
    check.last_run_at = now
    check.last_outcome = outcome.value
    check.last_message = result.message[:1000]
    check.last_latency_ms = result.latency_ms
    check.last_details = _trim_details(result.details)
    if new_state != prev_state:
        check.state = new_state
        check.state_changed_at = now

    dedup = f"check:{check.id}"
    failing = new_state in (HealthStatus.CRITICAL, HealthStatus.UNREACHABLE) or (
        new_state == HealthStatus.WARNING and outcome == CheckOutcomeStatus.DOWN)
    action = None
    if failing and outcome == CheckOutcomeStatus.DOWN:
        verb = "unreachable" if new_state == HealthStatus.UNREACHABLE else "failing"
        res = await engine.raise_condition(
            db, org=org, dedup_key=dedup,
            title=f"{resource.name}: {check.name} {verb}",
            severity=check.severity, source=IncidentSource.CHECK, source_id=str(check.id), resource=resource,
            description=f"{check.type.upper()} check '{check.name}' failed {check.consecutive_failures} consecutive time(s).",
            trigger_condition=result.message[:500],
            evidence={"last_result": {"status": outcome.value, "message": result.message[:500],
                                      "latency_ms": result.latency_ms, "http_status": result.http_status,
                                      "at": now.isoformat()},
                      "consecutive_failures": check.consecutive_failures,
                      # first failing slot — used for mean-time-to-detect reporting
                      "condition_started_at": (slot - timedelta(seconds=check.interval_seconds *
                                                                max(0, check.consecutive_failures - 1))).isoformat()},
            now=now,
        )
        action = res.action
    elif new_state in (HealthStatus.HEALTHY, HealthStatus.WARNING) and prev_state in (
            HealthStatus.CRITICAL, HealthStatus.UNREACHABLE, HealthStatus.WARNING) and outcome != CheckOutcomeStatus.DOWN:
        inc = await engine.clear_condition(db, org_id=org.id, dedup_key=dedup,
                                           message=f"Recovered: {result.message[:300]}",
                                           evidence={"at": now.isoformat(), "latency_ms": result.latency_ms}, now=now)
        action = "resolved" if inc else None

    # 3) SSL certificate expiry thresholds
    cert = (result.details or {}).get("certificate")
    if cert and "days_remaining" in cert and check.type in (CheckType.HTTP, CheckType.TLS, CheckType.SMTP):
        await evaluate_ssl(db, org, check, resource, cert, now)

    if new_state != prev_state:
        events.emit(db, org.id, "check_state", {
            "check_id": str(check.id), "resource_id": str(resource.id), "from": prev_state, "to": new_state,
            "message": result.message[:300],
        }, record={"kind": "check", "severity": "info" if new_state == HealthStatus.HEALTHY else "warning",
                   "resource_id": resource.id, "title": f"{check.name}: {prev_state} → {new_state}",
                   "message": result.message[:500]})
    await recompute_resource_status(db, resource, now=now)
    return {"state": new_state, "previous": prev_state, "incident_action": action, "in_maintenance": in_maint}


async def evaluate_ssl(db: AsyncSession, org: Organization, check: Check, resource: Resource, cert: dict[str, Any],
                       now: datetime) -> None:
    days = int(cert["days_remaining"])
    thresholds = check.config.get("ssl_alert_days") or (org.settings or {}).get("ssl_alert_days") or DEFAULT_SSL_DAYS
    dedup = f"ssl:{check.id}"
    th = ssl_threshold(days, [int(t) for t in thresholds])
    if th is None:
        await engine.clear_condition(db, org_id=org.id, dedup_key=dedup,
                                     message=f"Certificate renewed: {days} days remaining", now=now)
        return
    expired = days < 0 or cert.get("expired")
    title = (f"{resource.name}: TLS certificate expired" if expired
             else f"{resource.name}: TLS certificate expires in {days} day(s)")
    await engine.raise_condition(
        db, org=org, dedup_key=dedup, title=title, severity=ssl_severity(0 if expired else th),
        source=IncidentSource.SSL, source_id=str(check.id), resource=resource,
        description=f"Certificate for {cert.get('subject')} issued by {cert.get('issuer')} expires {cert.get('not_after')}.",
        trigger_condition=f"days_remaining={days} crossed threshold {th}",
        evidence={"certificate": {k: cert.get(k) for k in ("subject", "issuer", "not_after", "days_remaining", "serial")}},
        renotify_marker=f"ssl:{'expired' if expired else th}", now=now,
    )


def _trim_details(details: dict[str, Any] | None) -> dict[str, Any]:
    d = dict(details or {})
    s = json.dumps(d, default=str)
    if len(s) > 20000:
        d = {k: v for k, v in d.items() if k in ("certificate", "error", "failures", "redirects", "address",
                                                 "if_counters", "if_counters_ts", "sys_name", "uptime_seconds")}
    return json.loads(json.dumps(d, default=str))


# ----------------------------------------------------------------------------------------------
# Server metrics (agent telemetry)
# ----------------------------------------------------------------------------------------------

def merge_thresholds(org_t: dict[str, Any], server_t: dict[str, Any]) -> dict[str, dict[str, float]]:
    merged: dict[str, dict[str, float]] = {k: dict(v) for k, v in (org_t or {}).items() if isinstance(v, dict)}
    for k, v in (server_t or {}).items():
        if isinstance(v, dict):
            merged.setdefault(k, {}).update(v)
    return merged


def level_for(value: float, t: dict[str, float]) -> HealthStatus:
    crit, warn = t.get("critical"), t.get("warning")
    if crit is not None and value >= crit:
        return HealthStatus.CRITICAL
    if warn is not None and value >= warn:
        return HealthStatus.WARNING
    return HealthStatus.HEALTHY


METRIC_LABELS = {
    "cpu_percent": "CPU utilization",
    "memory_percent": "Memory usage",
    "disk_percent": "Disk usage",
    "load_per_core": "Load per CPU core",
    "swap_percent": "Swap usage",
    "inode_percent": "Inode usage",
}


async def evaluate_server_samples(db: AsyncSession, org: Organization, resource: Resource, server: ServerDetail,
                                  samples: dict[tuple[str, str], float], now: datetime | None = None) -> list[str]:
    """Evaluate the newest agent samples against thresholds. Returns changed metric keys."""
    now = now or _now()
    thresholds = merge_thresholds(org.thresholds, server.thresholds)
    consecutive = max(1, int((org.settings or {}).get("metric_consecutive_samples", 2)))
    derived = dict(samples)
    load1 = samples.get(("load1", ""))
    if load1 is not None and server.cpu_count:
        derived[("load_per_core", "")] = load1 / max(1, server.cpu_count)
    changed: list[str] = []
    states = {(s.metric_key): s for s in (await db.scalars(
        select(MetricState).where(MetricState.resource_id == resource.id).with_for_update()
    )).all()}
    for (metric, instance), value in derived.items():
        t = thresholds.get(metric)
        if not t:
            continue
        key = f"{metric}:{instance}" if instance else metric
        level = level_for(value, t)
        st = states.get(key)
        if st is None:
            st = MetricState(resource_id=resource.id, metric_key=key, organization_id=org.id,
                             level=HealthStatus.HEALTHY, since=now, pending_count=0)
            db.add(st)
            states[key] = st
        st.value = value
        st.updated_at = now
        if level == st.level:
            st.pending_level, st.pending_count = None, 0
            if level != HealthStatus.HEALTHY:
                # keep the incident's last_detected fresh while the breach continues
                await _raise_metric(db, org, resource, metric, instance, key, level, value, t, now)
            continue
        if st.pending_level == level:
            st.pending_count += 1
        else:
            st.pending_level, st.pending_count = level, 1
        if st.pending_count < consecutive:
            continue
        st.level, st.since, st.pending_level, st.pending_count = level, now, None, 0
        changed.append(key)
        if level == HealthStatus.HEALTHY:
            await engine.clear_condition(db, org_id=org.id, dedup_key=f"metric:{resource.id}:{key}",
                                         message=f"{METRIC_LABELS.get(metric, metric)} back to normal ({value:.1f})",
                                         evidence={"value": value}, now=now)
        else:
            await _raise_metric(db, org, resource, metric, instance, key, level, value, t, now)

    # Monitored services reported by the agent (service_up{name} = 0/1)
    monitored = set(server.monitored_services or [])
    for (metric, instance), value in samples.items():
        if metric != "service_up" or (monitored and instance not in monitored):
            continue
        key = f"service:{instance}"
        st = states.get(key)
        level = HealthStatus.HEALTHY if value >= 1 else HealthStatus.CRITICAL
        if st is None:
            st = MetricState(resource_id=resource.id, metric_key=key, organization_id=org.id,
                             level=HealthStatus.HEALTHY, since=now, pending_count=0)
            db.add(st)
            states[key] = st
        st.value, st.updated_at = value, now
        if level != st.level:
            st.level, st.since = level, now
            changed.append(key)
        dedup = f"service:{resource.id}:{instance}"
        if level == HealthStatus.CRITICAL:
            await engine.raise_condition(
                db, org=org, dedup_key=dedup, title=f"{resource.name}: service {instance} is not running",
                severity=Severity.CRITICAL, source=IncidentSource.AGENT, source_id=str(resource.id), resource=resource,
                trigger_condition=f"systemd unit {instance} inactive", evidence={"service": instance}, now=now)
        elif key in changed:
            await engine.clear_condition(db, org_id=org.id, dedup_key=dedup, message=f"Service {instance} running again",
                                         now=now)
    if changed:
        await recompute_resource_status(db, resource, now=now)
    return changed


async def _raise_metric(db: AsyncSession, org: Organization, resource: Resource, metric: str, instance: str, key: str,
                        level: HealthStatus, value: float, t: dict[str, float], now: datetime) -> None:
    label = METRIC_LABELS.get(metric, metric)
    where = f" on {instance}" if instance else ""
    limit = t.get("critical") if level == HealthStatus.CRITICAL else t.get("warning")
    await engine.raise_condition(
        db, org=org, dedup_key=f"metric:{resource.id}:{key}",
        title=f"{resource.name}: {label}{where} {level.value} ({value:.1f})",
        severity=Severity.CRITICAL if level == HealthStatus.CRITICAL else Severity.WARNING,
        source=IncidentSource.METRIC, source_id=str(resource.id), resource=resource,
        trigger_condition=f"{metric}{'{' + instance + '}' if instance else ''} = {value:.2f} >= {limit}",
        evidence={"metric": metric, "instance": instance, "value": round(value, 3), "threshold": t},
        renotify_marker=level.value, now=now,
    )


# ----------------------------------------------------------------------------------------------
# Agent liveness and resource health
# ----------------------------------------------------------------------------------------------

async def evaluate_agent_liveness(db: AsyncSession, now: datetime | None = None, limit: int = 500) -> int:
    """Raise "agent not reporting" for agents that newly exceeded their timeout. Returns the count.

    A single set-based query finds stale agents that do not yet have an open agent incident, so the
    cost per sweep is independent of how many agents are healthy or already known to be stale.
    """
    from sqlalchemy import Integer, and_, cast, exists, func, literal

    from app.models import Incident
    from app.models.enums import OPEN_INCIDENT_STATUSES

    now = now or _now()
    timeout = func.coalesce(ServerDetail.agent_timeout_seconds,
                            cast(Organization.settings["agent_timeout_seconds"].astext, Integer), 180)
    last = func.coalesce(Agent.last_seen_at, Agent.enrolled_at)
    open_incident = exists().where(and_(
        Incident.organization_id == Agent.organization_id,
        Incident.dedup_key == literal("agent:") + cast(Agent.server_id, sa_String()),
        Incident.status.in_([s.value for s in OPEN_INCIDENT_STATUSES])))
    rows = (await db.execute(
        select(Agent, Resource, Organization, timeout)
        .join(Resource, Resource.id == Agent.server_id)
        .join(Organization, Organization.id == Agent.organization_id)
        .outerjoin(ServerDetail, ServerDetail.resource_id == Agent.server_id)
        .where(Agent.status == AgentStatus.ACTIVE, Resource.is_paused.is_(False), Organization.is_active.is_(True),
               last < literal(now) - func.make_interval(0, 0, 0, 0, 0, 0, timeout), ~open_incident)
        .limit(limit)
    )).all()
    count = 0
    for agent, resource, org, timeout_s in rows:
        seen = agent.last_seen_at or agent.enrolled_at
        res = await engine.raise_condition(
            db, org=org, dedup_key=f"agent:{agent.server_id}",
            title=f"{resource.name}: agent not reporting (server unreachable)",
            severity=Severity.CRITICAL, source=IncidentSource.AGENT, source_id=str(agent.id), resource=resource,
            trigger_condition=f"no telemetry for {int((now - seen).total_seconds())}s (timeout {timeout_s}s)",
            evidence={"last_seen_at": seen.isoformat(), "timeout_seconds": timeout_s}, now=now)
        if res.action in ("created", "reopened"):
            count += 1
        await recompute_resource_status(db, resource, now=now)
    return count


def sa_String():  # noqa: N802 - small helper to keep the query readable
    from sqlalchemy import String

    return String()


async def agent_seen(db: AsyncSession, org: Organization, agent: Agent, resource: Resource, now: datetime) -> None:
    inc = await engine.clear_condition(db, org_id=org.id, dedup_key=f"agent:{resource.id}",
                                       message="Agent reconnected", now=now)
    if inc is not None or resource.status in (HealthStatus.UNKNOWN, HealthStatus.UNREACHABLE):
        await recompute_resource_status(db, resource, now=now)


async def recompute_resource_status(db: AsyncSession, resource: Resource, now: datetime | None = None) -> str:
    now = now or _now()
    statuses: list[HealthStatus] = []
    reasons: list[str] = []
    checks = (await db.scalars(select(Check).where(Check.resource_id == resource.id, Check.enabled.is_(True)))).all()
    for c in checks:
        try:
            st = HealthStatus(c.state)
        except ValueError:
            st = HealthStatus.UNKNOWN
        statuses.append(st)
        if st not in (HealthStatus.HEALTHY, HealthStatus.UNKNOWN):
            reasons.append(f"{c.name}: {c.last_message[:120]}")
    mstates = (await db.scalars(select(MetricState).where(MetricState.resource_id == resource.id))).all()
    for m in mstates:
        try:
            st = HealthStatus(m.level)
        except ValueError:
            continue
        statuses.append(st)
        if st != HealthStatus.HEALTHY:
            reasons.append(f"{m.metric_key} {st.value}")
    if resource.kind == ResourceKind.SERVER:
        from app.models import Incident
        from app.models.enums import OPEN_INCIDENT_STATUSES

        agent = await db.scalar(select(Agent).where(Agent.server_id == resource.id, Agent.status == AgentStatus.ACTIVE))
        if agent is not None:
            stale = await db.scalar(select(Incident.id).where(
                Incident.organization_id == resource.organization_id, Incident.dedup_key == f"agent:{resource.id}",
                Incident.status.in_([s.value for s in OPEN_INCIDENT_STATUSES])))
            if stale:
                statuses.append(HealthStatus.UNREACHABLE)
                reasons.insert(0, "agent not reporting")
            elif agent.last_seen_at:
                statuses.append(HealthStatus.HEALTHY)
    known = [s for s in statuses if s != HealthStatus.UNKNOWN]
    status = max(known, key=lambda s: HEALTH_RANK[s]) if known else HealthStatus.UNKNOWN
    windows = await maintenance.windows_for_resource(db, resource, resource.organization_id, now)
    if windows:
        reasons.insert(0, f"maintenance: {windows[0].name}")
        status = HealthStatus.MAINTENANCE
    if resource.is_paused:
        status = HealthStatus.UNKNOWN
        reasons = ["monitoring paused"]
    reason = "; ".join(reasons)[:500]
    if status != resource.status:
        prev = resource.status
        resource.status = status
        resource.status_changed_at = now
        resource.status_reason = reason
        events.emit(db, resource.organization_id, "resource_status", {
            "resource_id": str(resource.id), "kind": resource.kind, "name": resource.name, "from": prev, "to": status,
        }, record={"kind": "status_change", "resource_id": resource.id,
                   "severity": "info" if status in (HealthStatus.HEALTHY, HealthStatus.MAINTENANCE) else "warning",
                   "title": f"{resource.name}: {prev} → {status}", "message": reason})
    elif reason != resource.status_reason:
        resource.status_reason = reason
    return status
