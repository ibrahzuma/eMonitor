"""Alert rule evaluation engine.

Each rule is evaluated on its interval for every *subject* (resource, check, resource+instance
or "global"). Per-subject state (`alert_rule_states`) implements consecutive-breach gating,
recovery gating and cooldown, and incidents are raised/cleared through the incident engine
with dedup key `rule:{rule_id}:{subject}`.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.alerts.rules import (
    AgentDisconnectedCond,
    CompositeCond,
    ConsecutiveFailuresCond,
    ErrorRateCond,
    LogPatternCond,
    MetricThresholdCond,
    MissingTelemetryCond,
    ResponseTimeCond,
    RuleTarget,
    SslExpiryCond,
    compare,
    parse_condition,
)
from app.core import events
from app.incidents import engine
from app.models import Agent, AlertRule, AlertRuleState, Check, Organization, Resource, ResourceGroup
from app.models.enums import AgentStatus, AlertRuleType, CheckOutcomeStatus, CheckType, IncidentSource
from app.services import maintenance
from app.telemetry.store import LogQuery, get_store

log = logging.getLogger("emonitor.alerts")


@dataclass
class Observation:
    subject: str
    breached: bool
    value: float | None
    resource: Resource | None
    label: str
    detail: str


async def resolve_targets(db: AsyncSession, org_id: uuid.UUID, target: dict[str, Any],
                          default_kinds: list[str] | None = None) -> list[Resource]:
    t = RuleTarget.model_validate(target or {})
    stmt = select(Resource).where(Resource.organization_id == org_id, Resource.is_paused.is_(False))
    conds = []
    if t.resource_ids:
        conds.append(Resource.id.in_(t.resource_ids))
    if t.group_ids:
        groups = set(t.group_ids)
        # include nested groups
        frontier = set(t.group_ids)
        while frontier:
            children = set((await db.scalars(select(ResourceGroup.id).where(
                ResourceGroup.organization_id == org_id, ResourceGroup.parent_id.in_(frontier)))).all()) - groups
            groups |= children
            frontier = children
        conds.append(Resource.group_id.in_(groups))
    if t.tags:
        conds.append(Resource.tags.overlap(t.tags))
    if conds:
        stmt = stmt.where(or_(*conds))
    kinds = t.kinds or ([] if conds else (default_kinds or []))
    if kinds:
        stmt = stmt.where(Resource.kind.in_(kinds))
    if t.environments:
        stmt = stmt.where(Resource.environment.in_(t.environments))
    return list((await db.scalars(stmt.limit(5000))).all())


async def _target_checks(db: AsyncSession, org_id: uuid.UUID, rule: AlertRule,
                         types: list[str] | None = None) -> list[tuple[Check, Resource]]:
    t = RuleTarget.model_validate(rule.target or {})
    stmt = select(Check, Resource).join(Resource, Resource.id == Check.resource_id).where(
        Check.organization_id == org_id, Check.enabled.is_(True), Resource.is_paused.is_(False))
    if t.check_ids:
        stmt = stmt.where(Check.id.in_(t.check_ids))
    else:
        resources = await resolve_targets(db, org_id, rule.target, None)
        stmt = stmt.where(Check.resource_id.in_([r.id for r in resources]))
    if types:
        stmt = stmt.where(Check.type.in_(types))
    return [(c, r) for c, r in (await db.execute(stmt.limit(5000))).all()]


async def observe(db: AsyncSession, org: Organization, rule: AlertRule, now: datetime) -> list[Observation]:
    cond = parse_condition(rule.rule_type, rule.condition)
    store = get_store()
    obs: list[Observation] = []

    if isinstance(cond, MetricThresholdCond):
        resources = await resolve_targets(db, org.id, rule.target, ["server", "network_device", "database"])
        if not resources:
            return []
        values = await store.metric_aggregate(org.id, [r.id for r in resources], cond.metric, cond.instance,
                                              cond.aggregation, now - timedelta(seconds=cond.window_seconds), now)
        by_id = {r.id: r for r in resources}
        for (rid, inst), v in values.items():
            r = by_id.get(rid)
            if r is None:
                continue
            obs.append(Observation(f"{rid}:{inst}" if inst else str(rid), compare(v, cond.operator, cond.threshold), v, r,
                                   f"{cond.aggregation}({cond.metric}{'{' + inst + '}' if inst else ''})",
                                   f"{cond.aggregation} {cond.metric} over {cond.window_seconds}s = {v:.2f} "
                                   f"({cond.operator} {cond.threshold})"))
        return obs

    if isinstance(cond, ResponseTimeCond):
        pairs = await _target_checks(db, org.id, rule, [CheckType.HTTP, CheckType.TCP, CheckType.DNS, CheckType.ICMP,
                                                         CheckType.POSTGRES, CheckType.MYSQL, CheckType.REDIS])
        stats = await store.check_stats(org.id, [c.id for c, _ in pairs], now - timedelta(seconds=cond.window_seconds), now)
        key = {"avg": "avg_ms", "p95": "p95_ms", "p99": "p99_ms", "max": "max_ms"}[cond.aggregation]
        for c, r in pairs:
            v = (stats.get(c.id) or {}).get(key)
            if v is None:
                continue
            obs.append(Observation(str(c.id), compare(float(v), cond.operator, cond.threshold_ms), float(v), r,
                                   f"{cond.aggregation} response time of {c.name}",
                                   f"{cond.aggregation} response time {v:.0f} ms ({cond.operator} {cond.threshold_ms:.0f} ms)"))
        return obs

    if isinstance(cond, ConsecutiveFailuresCond) or rule.rule_type == AlertRuleType.WEBSITE_DOWN:
        types = [CheckType.HTTP] if rule.rule_type == AlertRuleType.WEBSITE_DOWN else None
        for c, r in await _target_checks(db, org.id, rule, types):
            if rule.rule_type == AlertRuleType.WEBSITE_DOWN:
                breached = c.last_outcome == CheckOutcomeStatus.DOWN
                detail = f"{c.name} is down: {c.last_message[:200]}"
            else:
                assert isinstance(cond, ConsecutiveFailuresCond)
                breached = c.consecutive_failures >= cond.failures
                detail = f"{c.name} failed {c.consecutive_failures} consecutive times: {c.last_message[:200]}"
            obs.append(Observation(str(c.id), breached, float(c.consecutive_failures), r, c.name, detail))
        return obs

    if isinstance(cond, SslExpiryCond):
        for c, r in await _target_checks(db, org.id, rule, [CheckType.HTTP, CheckType.TLS, CheckType.SMTP]):
            cert = (c.last_details or {}).get("certificate") or {}
            if "days_remaining" not in cert:
                continue
            days = int(cert["days_remaining"])
            obs.append(Observation(str(c.id), days <= cond.days, float(days), r, f"certificate of {c.name}",
                                   f"certificate expires in {days} days (alert at {cond.days})"))
        return obs

    if isinstance(cond, LogPatternCond):
        start = now - timedelta(seconds=cond.window_seconds)
        base = dict(start=start, end=now, text=cond.query, severities=cond.severities, min_severity=cond.min_severity,
                    applications=cond.applications, services=cond.services)
        if cond.per_resource:
            for r in await resolve_targets(db, org.id, rule.target, ["server", "application", "service"]):
                n = await store.count_logs(org.id, LogQuery(**base, resource_ids=[r.id]))
                obs.append(Observation(str(r.id), compare(n, cond.operator, cond.threshold), float(n), r,
                                       "matching log events", f"{n} matching log events in {cond.window_seconds}s"))
        else:
            n = await store.count_logs(org.id, LogQuery(**base))
            obs.append(Observation("global", compare(n, cond.operator, cond.threshold), float(n), None,
                                   "matching log events", f"{n} log events matched '{cond.query}' in {cond.window_seconds}s"))
        return obs

    if isinstance(cond, ErrorRateCond):
        start = now - timedelta(seconds=cond.window_seconds)
        if cond.source == "logs":
            total = await store.count_logs(org.id, LogQuery(start=start, end=now, applications=cond.applications))
            errors = await store.count_logs(org.id, LogQuery(start=start, end=now, applications=cond.applications,
                                                             min_severity="error"))
            if total >= cond.min_events:
                rate = errors / total * 100
                obs.append(Observation("global", rate >= cond.threshold_percent, rate, None, "log error rate",
                                       f"error rate {rate:.1f}% ({errors}/{total}) >= {cond.threshold_percent}%"))
        else:
            pairs = await _target_checks(db, org.id, rule)
            stats = await store.check_stats(org.id, [c.id for c, _ in pairs], start, now)
            for c, r in pairs:
                st = stats.get(c.id)
                if not st:
                    continue
                total = st["up"] + st["degraded"] + st["down"]
                if total < cond.min_events:
                    continue
                rate = st["down"] / total * 100
                obs.append(Observation(str(c.id), rate >= cond.threshold_percent, rate, r, f"failure rate of {c.name}",
                                       f"{rate:.1f}% of checks failed ({st['down']}/{total})"))
        return obs

    if isinstance(cond, MissingTelemetryCond):
        resources = await resolve_targets(db, org.id, rule.target, ["server"])
        if not resources:
            return []
        values = await store.metric_aggregate(org.id, [r.id for r in resources], cond.metric, None, "count",
                                              now - timedelta(seconds=cond.window_seconds), now)
        seen = {rid for (rid, _), v in values.items() if v > 0}
        for r in resources:
            missing = r.id not in seen
            obs.append(Observation(str(r.id), missing, 0.0 if missing else 1.0, r, f"{cond.metric} telemetry",
                                   f"no {cond.metric} samples received in {cond.window_seconds}s"))
        return obs

    if isinstance(cond, AgentDisconnectedCond):
        resources = await resolve_targets(db, org.id, rule.target, ["server"])
        agents = {a.server_id: a for a in (await db.scalars(select(Agent).where(
            Agent.server_id.in_([r.id for r in resources]), Agent.status == AgentStatus.ACTIVE))).all()}
        for r in resources:
            a = agents.get(r.id)
            if a is None:
                continue
            last = a.last_seen_at or a.enrolled_at
            age = (now - last).total_seconds()
            obs.append(Observation(str(r.id), age > cond.seconds, age, r, "agent last seen",
                                   f"agent last reported {int(age)}s ago (limit {cond.seconds}s)"))
        return obs

    if isinstance(cond, CompositeCond):
        firing = []
        for rid in cond.rule_ids:
            st = await db.scalar(select(AlertRuleState.subject_key).where(
                AlertRuleState.rule_id == rid, AlertRuleState.organization_id == org.id,
                AlertRuleState.state == "firing").limit(1))
            firing.append(st is not None)
        breached = all(firing) if cond.operator == "and" else any(firing)
        obs.append(Observation("global", breached, float(sum(firing)), None, "composite condition",
                               f"{sum(firing)}/{len(firing)} referenced rules firing ({cond.operator.upper()})"))
        return obs
    return obs


async def apply_observation(db: AsyncSession, org: Organization, rule: AlertRule, ob: Observation,
                            now: datetime) -> str:
    st = await db.scalar(select(AlertRuleState).where(AlertRuleState.rule_id == rule.id,
                                                      AlertRuleState.subject_key == ob.subject).with_for_update())
    if st is None:
        st = AlertRuleState(rule_id=rule.id, subject_key=ob.subject, organization_id=org.id, state="ok", breaches=0,
                            oks=0, updated_at=now)
        db.add(st)
    st.last_value = ob.value
    st.updated_at = now
    dedup = f"rule:{rule.id}:{ob.subject}"
    if ob.breached:
        if rule.suppress_in_maintenance and ob.resource is not None and \
                await maintenance.windows_for_resource(db, ob.resource, org.id, now):
            return "suppressed"
        st.breaches += 1
        st.oks = 0
        if st.state == "firing":
            await engine.raise_condition(
                db, org=org, dedup_key=dedup, title=f"{rule.name}: {ob.resource.name if ob.resource else ob.label}",
                severity=rule.severity, source=IncidentSource.RULE, source_id=str(rule.id), resource=ob.resource,
                trigger_condition=ob.detail, evidence={"value": ob.value}, auto_resolve=rule.auto_resolve,
                alert_rule_id=rule.id, notification_policy_id=rule.notification_policy_id, now=now)
            return "firing"
        if st.breaches < max(1, rule.consecutive_breaches):
            st.state = "pending"
            return "pending"
        if st.last_resolved_at and (now - st.last_resolved_at).total_seconds() < rule.cooldown_seconds:
            st.state = "pending"
            return "cooldown"
        st.state = "firing"
        st.last_fired_at = now
        await engine.raise_condition(
            db, org=org, dedup_key=dedup, title=f"{rule.name}: {ob.resource.name if ob.resource else ob.label}",
            severity=rule.severity, source=IncidentSource.RULE, source_id=str(rule.id), resource=ob.resource,
            description=rule.description, trigger_condition=ob.detail, evidence={"value": ob.value, "rule": rule.name},
            auto_resolve=rule.auto_resolve, alert_rule_id=rule.id, notification_policy_id=rule.notification_policy_id,
            now=now)
        return "fired"
    st.oks += 1
    st.breaches = 0
    if st.state == "firing":
        if st.oks < max(1, rule.recovery_consecutive):
            return "recovering"
        st.state = "ok"
        st.last_resolved_at = now
        await engine.clear_condition(db, org_id=org.id, dedup_key=dedup, message=f"Rule condition recovered: {ob.detail}",
                                     evidence={"value": ob.value}, now=now)
        return "resolved"
    st.state = "ok"
    return "ok"


async def evaluate_rule(db: AsyncSession, rule: AlertRule, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(UTC)
    org = await db.get(Organization, rule.organization_id)
    assert org is not None
    counts: dict[str, int] = {}
    observations = await observe(db, org, rule, now)
    seen = set()
    for ob in observations:
        seen.add(ob.subject)
        outcome = await apply_observation(db, org, rule, ob, now)
        counts[outcome] = counts.get(outcome, 0) + 1
    # Subjects that disappeared (resource deleted / untargeted) recover.
    stale = (await db.scalars(select(AlertRuleState).where(AlertRuleState.rule_id == rule.id,
                                                           AlertRuleState.state != "ok"))).all()
    for st in stale:
        if st.subject_key not in seen and rule.rule_type not in (AlertRuleType.MISSING_TELEMETRY,):
            st.state, st.breaches, st.last_resolved_at = "ok", 0, now
            await engine.clear_condition(db, org_id=org.id, dedup_key=f"rule:{rule.id}:{st.subject_key}",
                                         message="Subject no longer evaluated by rule", now=now)
    rule.last_eval_at = now
    rule.last_error = ""
    return counts


async def evaluate_due_rules(sessionmaker: Any, now: datetime | None = None, limit: int = 100) -> int:
    now = now or datetime.now(UTC)
    async with sessionmaker() as db:
        rules = (await db.scalars(select(AlertRule).where(AlertRule.enabled.is_(True), AlertRule.next_eval_at <= now)
                                  .order_by(AlertRule.next_eval_at).limit(limit).with_for_update(skip_locked=True))).all()
        ids = []
        for r in rules:
            r.next_eval_at = now + timedelta(seconds=max(15, r.evaluation_interval_seconds))
            ids.append(r.id)
        await db.commit()
    for rid in ids:
        async with sessionmaker() as db:
            rule = await db.get(AlertRule, rid)
            if rule is None:
                continue
            try:
                await evaluate_rule(db, rule, now)
                await events.commit(db)
            except Exception as exc:
                await db.rollback()
                events.discard_deferred(db)
                log.exception("rule evaluation failed", extra={"rule_id": str(rid)})
                rule = await db.get(AlertRule, rid)
                if rule:
                    rule.last_error = f"{exc.__class__.__name__}: {exc}"[:1000]
                    await db.commit()
    return len(ids)
