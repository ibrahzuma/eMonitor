"""Report builders. Each returns a `Report` (title, columns, rows, summary) for JSON/CSV/PDF output."""

from __future__ import annotations

import csv
import io
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Check, Incident, NotificationDelivery, Resource, Slo
from app.services.availability import check_availability, combine, compute_slo
from app.telemetry.store import LogQuery, get_store


@dataclass
class Report:
    title: str
    columns: list[dict[str, str]]  # [{"key": "name", "label": "Name"}]
    rows: list[dict[str, Any]]
    summary: dict[str, Any] = field(default_factory=dict)
    start: datetime | None = None
    end: datetime | None = None
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"title": self.title, "columns": self.columns, "rows": self.rows, "summary": self.summary,
                "start": self.start, "end": self.end, "notes": self.notes}


def _cols(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    return [{"key": k, "label": label} for k, label in pairs]


@dataclass
class Filters:
    kinds: list[str] = field(default_factory=list)
    environment: str | None = None
    team_id: uuid.UUID | None = None
    group_id: uuid.UUID | None = None
    resource_ids: list[uuid.UUID] = field(default_factory=list)


async def _resources(db: AsyncSession, org_id: uuid.UUID, f: Filters, default_kinds: list[str] | None = None) -> list[Resource]:
    stmt = select(Resource).where(Resource.organization_id == org_id)
    kinds = f.kinds or default_kinds
    if kinds:
        stmt = stmt.where(Resource.kind.in_(kinds))
    if f.environment:
        stmt = stmt.where(Resource.environment == f.environment)
    if f.team_id:
        stmt = stmt.where(Resource.team_id == f.team_id)
    if f.group_id:
        stmt = stmt.where(Resource.group_id == f.group_id)
    if f.resource_ids:
        stmt = stmt.where(Resource.id.in_(f.resource_ids))
    return list((await db.scalars(stmt.order_by(Resource.kind, Resource.name).limit(5000))).all())


def _hms(seconds: float | None) -> str:
    if seconds is None:
        return ""
    s = int(seconds)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return (f"{d}d " if d else "") + f"{h:02d}:{m:02d}:{s:02d}"


async def availability_report(db: AsyncSession, org_id: uuid.UUID, start: datetime, end: datetime, f: Filters,
                              title: str = "Availability report", default_kinds: list[str] | None = None) -> Report:
    resources = await _resources(db, org_id, f, default_kinds)
    checks = list((await db.scalars(select(Check).where(Check.resource_id.in_([r.id for r in resources])))).all()) \
        if resources else []
    av = await check_availability(org_id, checks, start, end)
    by_res: dict[uuid.UUID, list] = defaultdict(list)
    for c in checks:
        by_res[c.resource_id].append(av[c.id])
    rows = []
    for r in resources:
        a = combine(by_res.get(r.id, []))
        if a is None:
            continue
        rows.append({
            "resource": r.name, "kind": r.kind, "environment": r.environment,
            "uptime_percent": a.uptime_percent, "coverage_percent": a.coverage_percent,
            "down_checks": a.down, "unknown_checks": a.unknown, "maintenance_checks": a.maintenance,
            "downtime": _hms(a.downtime_seconds), "avg_response_ms": round(a.avg_ms, 1) if a.avg_ms else None,
            "p95_response_ms": round(a.p95_ms, 1) if a.p95_ms else None,
        })
    known = [r["uptime_percent"] for r in rows if r["uptime_percent"] is not None]
    return Report(
        title=title, start=start, end=end,
        columns=_cols(("resource", "Resource"), ("kind", "Kind"), ("environment", "Environment"),
                      ("uptime_percent", "Uptime %"), ("coverage_percent", "Coverage %"), ("downtime", "Downtime"),
                      ("down_checks", "Failed checks"), ("unknown_checks", "Unknown slots"),
                      ("maintenance_checks", "Maintenance slots"), ("avg_response_ms", "Avg ms"),
                      ("p95_response_ms", "P95 ms")),
        rows=rows,
        summary={"resources": len(rows), "average_uptime_percent": round(sum(known) / len(known), 4) if known else None},
        notes=["Uptime % = (up + degraded) / (up + degraded + down) over known, non-maintenance check slots.",
               "Coverage % = share of expected slots with a known result (or maintenance). Unknown slots are "
               "never counted as up or down."],
    )


async def incident_report(db: AsyncSession, org_id: uuid.UUID, start: datetime, end: datetime, f: Filters) -> Report:
    stmt = select(Incident).where(Incident.organization_id == org_id, Incident.first_detected_at >= start,
                                  Incident.first_detected_at < end)
    if f.team_id:
        stmt = stmt.where(Incident.team_id == f.team_id)
    if f.resource_ids:
        stmt = stmt.where(Incident.resource_id.in_(f.resource_ids))
    if f.environment or f.kinds or f.group_id:
        rids = [r.id for r in await _resources(db, org_id, f)]
        stmt = stmt.where(Incident.resource_id.in_(rids))
    incidents = list((await db.scalars(stmt.limit(100000))).all())
    tta = [(i.acknowledged_at - i.first_detected_at).total_seconds() for i in incidents if i.acknowledged_at]
    ttr = [(i.resolved_at - i.first_detected_at).total_seconds() for i in incidents if i.resolved_at]
    ttd = []
    for i in incidents:
        started = (i.evidence or {}).get("condition_started_at")
        if started:
            try:
                ttd.append(max(0.0, (i.first_detected_at - datetime.fromisoformat(started)).total_seconds()))
            except ValueError:
                pass
    by_day: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    by_sev: dict[str, int] = defaultdict(int)
    by_source: dict[str, int] = defaultdict(int)
    by_resource: dict[uuid.UUID | None, int] = defaultdict(int)
    for i in incidents:
        by_day[i.first_detected_at.strftime("%Y-%m-%d")][i.severity] += 1
        by_sev[i.severity] += 1
        by_source[i.source] += 1
        by_resource[i.resource_id] += 1
    names = {r.id: r.name for r in (await db.scalars(select(Resource).where(
        Resource.id.in_([k for k in by_resource if k])))).all()} if by_resource else {}
    rows = [{"date": d, "critical": v.get("critical", 0), "high": v.get("high", 0), "warning": v.get("warning", 0),
             "info": v.get("info", 0), "total": sum(v.values())} for d, v in sorted(by_day.items())]

    def avg(x: list[float]) -> float | None:
        return round(sum(x) / len(x), 1) if x else None

    top = sorted(((names.get(k, "—") if k else "(no resource)", n) for k, n in by_resource.items()), key=lambda t: -t[1])
    return Report(
        title="Incident report", start=start, end=end,
        columns=_cols(("date", "Date"), ("critical", "Critical"), ("high", "High"), ("warning", "Warning"),
                      ("info", "Info"), ("total", "Total")),
        rows=rows,
        summary={
            "total": len(incidents), "open": sum(1 for i in incidents if i.status != "resolved"),
            "by_severity": dict(by_sev), "by_source": dict(by_source),
            "mttd_seconds": avg(ttd), "mtta_seconds": avg(tta), "mttr_seconds": avg(ttr),
            "mttd": _hms(avg(ttd)), "mtta": _hms(avg(tta)), "mttr": _hms(avg(ttr)),
            "reopened": sum(1 for i in incidents if i.reopen_count),
            "top_resources": [{"resource": n, "incidents": c} for n, c in top[:10]],
        },
        notes=["MTTD: first failing observation → incident creation (check-based incidents).",
               "MTTA: incident first detected → first acknowledgement.",
               "MTTR: incident first detected → resolution (automatic or manual)."],
    )


async def alert_volume_report(db: AsyncSession, org_id: uuid.UUID, start: datetime, end: datetime) -> Report:
    rows_q = await db.execute(select(NotificationDelivery.channel_type, NotificationDelivery.status, func.count())
                              .where(NotificationDelivery.organization_id == org_id,
                                     NotificationDelivery.created_at >= start, NotificationDelivery.created_at < end)
                              .group_by(NotificationDelivery.channel_type, NotificationDelivery.status))
    per: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for ch, st, n in rows_q.all():
        per[ch][st] += n
    src = await db.execute(select(Incident.source, func.count()).where(
        Incident.organization_id == org_id, Incident.first_detected_at >= start, Incident.first_detected_at < end)
        .group_by(Incident.source))
    rows = [{"channel": ch, "sent": v.get("sent", 0), "failed": v.get("failed", 0), "suppressed": v.get("suppressed", 0),
             "pending": v.get("pending", 0), "total": sum(v.values())} for ch, v in sorted(per.items())]
    return Report(title="Alert volume", start=start, end=end,
                  columns=_cols(("channel", "Channel"), ("sent", "Sent"), ("failed", "Failed"),
                                ("suppressed", "Suppressed"), ("pending", "Pending"), ("total", "Total")),
                  rows=rows, summary={"incidents_by_source": dict(src.all()),
                                      "notifications": sum(r["total"] for r in rows)})


async def utilization_report(db: AsyncSession, org_id: uuid.UUID, start: datetime, end: datetime, f: Filters) -> Report:
    servers = await _resources(db, org_id, f, ["server"])
    ids = [s.id for s in servers]
    store = get_store()
    data: dict[str, dict] = {}
    if ids:
        for metric in ("cpu_percent", "memory_percent"):
            for agg in ("avg", "max", "p95"):
                data[f"{metric}:{agg}"] = await store.metric_aggregate(org_id, ids, metric, "", agg, start, end)
        data["disk:max"] = await store.metric_aggregate(org_id, ids, "disk_percent", None, "max", start, end)
        data["rx:avg"] = await store.metric_aggregate(org_id, ids, "net_rx_bytes_ps", None, "avg", start, end)
        data["tx:avg"] = await store.metric_aggregate(org_id, ids, "net_tx_bytes_ps", None, "avg", start, end)

    def g(key: str, rid: uuid.UUID) -> float | None:
        v = data.get(key, {}).get((rid, ""))
        return round(v, 2) if v is not None else None

    def by_rid(key: str, rid: uuid.UUID, reducer) -> float | None:
        vals = [v for (r, _), v in data.get(key, {}).items() if r == rid]
        return round(reducer(vals), 2) if vals else None

    rows = [{
        "server": s.name, "environment": s.environment,
        "cpu_avg": g("cpu_percent:avg", s.id), "cpu_p95": g("cpu_percent:p95", s.id), "cpu_max": g("cpu_percent:max", s.id),
        "mem_avg": g("memory_percent:avg", s.id), "mem_p95": g("memory_percent:p95", s.id),
        "mem_max": g("memory_percent:max", s.id), "disk_max": by_rid("disk:max", s.id, max),
        "net_rx_avg_mbps": (lambda v: round(v * 8 / 1e6, 3) if v is not None else None)(by_rid("rx:avg", s.id, sum)),
        "net_tx_avg_mbps": (lambda v: round(v * 8 / 1e6, 3) if v is not None else None)(by_rid("tx:avg", s.id, sum)),
    } for s in servers]
    return Report(title="Server utilization", start=start, end=end,
                  columns=_cols(("server", "Server"), ("environment", "Env"), ("cpu_avg", "CPU avg %"),
                                ("cpu_p95", "CPU p95 %"), ("cpu_max", "CPU max %"), ("mem_avg", "Mem avg %"),
                                ("mem_p95", "Mem p95 %"), ("mem_max", "Mem max %"), ("disk_max", "Disk max %"),
                                ("net_rx_avg_mbps", "RX avg Mbit/s"), ("net_tx_avg_mbps", "TX avg Mbit/s")),
                  rows=rows, summary={"servers": len(rows)})


async def capacity_report(db: AsyncSession, org_id: uuid.UUID, start: datetime, end: datetime, f: Filters) -> Report:
    """Disk capacity trend: linear growth between first and last day; projected days until full."""
    servers = await _resources(db, org_id, f, ["server"])
    store = get_store()
    rows = []
    if servers:
        series = await store.metric_series(org_id, [s.id for s in servers], "disk_percent", None, start, end, 86400, "avg")
        names = {s.id: s.name for s in servers}
        grouped: dict[tuple, list] = defaultdict(list)
        for p in series:
            grouped[(p["resource_id"], p["instance"])].append((p["ts"], p["value"]))
        for (rid, mount), pts in grouped.items():
            pts.sort()
            first, last = pts[0], pts[-1]
            days = max((last[0] - first[0]).total_seconds() / 86400, 0)
            growth = (last[1] - first[1]) / days if days >= 1 else None
            until_full = round((100 - last[1]) / growth, 1) if growth and growth > 0 else None
            rows.append({"server": names.get(uuid.UUID(str(rid)), str(rid)), "mount": mount,
                         "current_percent": round(last[1], 2), "start_percent": round(first[1], 2),
                         "growth_per_day": round(growth, 3) if growth is not None else None,
                         "days_until_full": until_full})
    rows.sort(key=lambda r: (r["days_until_full"] is None, r["days_until_full"] or 0))
    return Report(title="Disk capacity trends", start=start, end=end,
                  columns=_cols(("server", "Server"), ("mount", "Mount"), ("start_percent", "Start %"),
                                ("current_percent", "Current %"), ("growth_per_day", "Growth %/day"),
                                ("days_until_full", "Days until full")),
                  rows=rows, notes=["Projection is a linear extrapolation of daily averages; treat as indicative."])


async def ssl_report(db: AsyncSession, org_id: uuid.UUID) -> Report:
    rows_q = await db.execute(select(Check, Resource.name).join(Resource, Resource.id == Check.resource_id).where(
        Check.organization_id == org_id, Check.type.in_(["http", "tls", "smtp"])))
    rows = []
    for c, name in rows_q.all():
        cert = (c.last_details or {}).get("certificate")
        if not cert:
            continue
        rows.append({"resource": name, "check": c.name, "subject": cert.get("subject"), "issuer": cert.get("issuer"),
                     "not_after": cert.get("not_after"), "days_remaining": cert.get("days_remaining"),
                     "verified": cert.get("verified", c.last_outcome != "down")})
    rows.sort(key=lambda r: r["days_remaining"] if r["days_remaining"] is not None else 99999)
    return Report(title="TLS certificate expiration",
                  columns=_cols(("resource", "Resource"), ("check", "Check"), ("subject", "Subject"),
                                ("issuer", "Issuer"), ("not_after", "Expires"), ("days_remaining", "Days left")),
                  rows=rows, summary={"expiring_30d": sum(1 for r in rows if (r["days_remaining"] or 0) <= 30),
                                      "expired": sum(1 for r in rows if (r["days_remaining"] or 0) < 0)})


async def domain_report(db: AsyncSession, org_id: uuid.UUID) -> Report:
    rows_q = await db.execute(select(Check, Resource.name).join(Resource, Resource.id == Check.resource_id).where(
        Check.organization_id == org_id, Check.type == "domain"))
    rows = []
    for c, name in rows_q.all():
        d = (c.last_details or {}).get("domain") or {}
        rows.append({"resource": name, "domain": d.get("name") or c.config.get("domain"),
                     "registrar": d.get("registrar"), "expires_at": d.get("expires_at"),
                     "days_remaining": d.get("days_remaining"), "source": d.get("source"),
                     "status": c.last_outcome, "message": c.last_message})
    rows.sort(key=lambda r: r["days_remaining"] if r["days_remaining"] is not None else 99999)
    return Report(title="Domain registration expiry",
                  columns=_cols(("resource", "Resource"), ("domain", "Domain"), ("registrar", "Registrar"),
                                ("expires_at", "Expires"), ("days_remaining", "Days left"), ("source", "Source"),
                                ("status", "Last check")),
                  rows=rows, summary={"expiring_60d": sum(1 for r in rows if (r["days_remaining"] or 9999) <= 60),
                                      "unknown": sum(1 for r in rows if r["days_remaining"] is None)},
                  notes=["Expiry dates come from the registry's RDAP service, or WHOIS when RDAP is unavailable."])


async def log_error_report(db: AsyncSession, org_id: uuid.UUID, start: datetime, end: datetime) -> Report:
    store = get_store()
    bucket = 86400 if (end - start) > timedelta(days=2) else 3600
    total = await store.log_histogram(org_id, LogQuery(start=start, end=end), bucket)
    per: dict[datetime, dict[str, int]] = defaultdict(lambda: {"total": 0, "errors": 0})
    for p in total:
        per[p["bucket"]]["total"] += int(p["count"])
        if p["severity"] in ("error", "critical", "alert", "emergency"):
            per[p["bucket"]]["errors"] += int(p["count"])
    rows = [{"period": b.isoformat(), "total": v["total"], "errors": v["errors"],
             "error_rate_percent": round(v["errors"] / v["total"] * 100, 3) if v["total"] else None}
            for b, v in sorted(per.items())]
    apps = await store.log_facets(org_id, LogQuery(start=start, end=end, min_severity="error"), "application", 10)
    return Report(title="Log error rates", start=start, end=end,
                  columns=_cols(("period", "Period"), ("total", "Log events"), ("errors", "Errors"),
                                ("error_rate_percent", "Error rate %")),
                  rows=rows, summary={"top_error_applications": apps,
                                      "total": sum(r["total"] for r in rows), "errors": sum(r["errors"] for r in rows)})


async def sla_report(db: AsyncSession, org_id: uuid.UUID) -> Report:
    slos = (await db.scalars(select(Slo).where(Slo.organization_id == org_id).order_by(Slo.name))).all()
    names = {r.id: r.name for r in (await db.scalars(select(Resource).where(
        Resource.id.in_([s.resource_id for s in slos])))).all()} if slos else {}
    rows = []
    for s in slos:
        st = await compute_slo(db, s)
        rows.append({"slo": s.name, "resource": names.get(s.resource_id, ""), "target_percent": s.target_percent,
                     "window_days": s.window_days, "sli_percent": st.sli_percent,
                     "error_budget_remaining_percent": st.error_budget_remaining_percent,
                     "burn_rate_1h": round(st.burn_rate_1h, 2) if st.burn_rate_1h is not None else None,
                     "status": st.status, "compliant": st.sli_percent is not None and st.sli_percent >= s.target_percent})
    return Report(title="SLA / SLO compliance",
                  columns=_cols(("slo", "SLO"), ("resource", "Resource"), ("target_percent", "Target %"),
                                ("window_days", "Window (d)"), ("sli_percent", "SLI %"),
                                ("error_budget_remaining_percent", "Budget left %"), ("burn_rate_1h", "Burn 1h"),
                                ("status", "Status")),
                  rows=rows, summary={"total": len(rows), "compliant": sum(1 for r in rows if r["compliant"])})


# ---------------------------------------------------------------- rendering

def _cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat()
    s = str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@") and not _is_number(s) else s


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def to_csv(rep: Report) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([c["label"] for c in rep.columns])
    for r in rep.rows:
        w.writerow([_cell(r.get(c["key"])) for c in rep.columns])
    return buf.getvalue()


def to_pdf(rep: Report, org_name: str) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=12 * mm, rightMargin=12 * mm, topMargin=12 * mm,
                            bottomMargin=12 * mm, title=rep.title)
    styles = getSampleStyleSheet()
    story: list[Any] = [Paragraph(f"{rep.title} — {org_name}", styles["Title"])]
    period = ""
    if rep.start and rep.end:
        period = f"Period: {rep.start:%Y-%m-%d %H:%M} – {rep.end:%Y-%m-%d %H:%M} UTC. "
    story.append(Paragraph(f"{period}Generated {datetime.now(UTC):%Y-%m-%d %H:%M} UTC.", styles["Normal"]))
    story.append(Spacer(1, 4 * mm))
    flat = {k: v for k, v in rep.summary.items() if isinstance(v, (int, float, str)) and v is not None}
    if flat:
        story.append(Paragraph(" · ".join(f"<b>{k.replace('_', ' ')}</b>: {v}" for k, v in flat.items()), styles["Normal"]))
        story.append(Spacer(1, 4 * mm))
    small = styles["BodyText"].clone("small", fontSize=7, leading=8)
    data = [[Paragraph(f"<b>{c['label']}</b>", small) for c in rep.columns]]
    for r in rep.rows[:2000]:
        data.append([Paragraph(_cell(r.get(c["key"])).replace("&", "&amp;").replace("<", "&lt;"), small)
                     for c in rep.columns])
    if len(data) == 1:
        data.append([Paragraph("No data for the selected period.", small)] + [""] * (len(rep.columns) - 1))
    table = Table(data, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5e7eb")),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d1d5db")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(table)
    for n in rep.notes:
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(f"<i>{n}</i>", small))
    doc.build(story)
    return buf.getvalue()
