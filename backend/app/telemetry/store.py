"""Telemetry store abstraction over ClickHouse.

`ClickHouseStore` is the production implementation. `MemoryStore` implements identical
semantics in-process and exists only for automated tests and single-process development
(`EMONITOR_TELEMETRY_BACKEND=memory`, refused in production).

Every query is scoped by `org_id` and uses server-side parameter binding; user-provided values
are never interpolated into SQL text.
"""

from __future__ import annotations

import asyncio
import base64
import bisect
import json
import logging
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from app.core.config import get_settings

log = logging.getLogger("emonitor.telemetry")

ZERO_UUID = uuid.UUID(int=0)
TABLES = ("metrics", "check_results", "logs", "events")
SEVERITY_NUM = {
    "emergency": 0, "alert": 1, "critical": 2, "error": 3, "warning": 4, "notice": 5, "info": 6, "debug": 7,
}
_ALNUM = re.compile(r"^[A-Za-z0-9]+$")
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
AGGREGATIONS = {"avg", "min", "max", "sum", "last", "p95", "p99", "count"}


@dataclass
class LogQuery:
    start: datetime
    end: datetime
    text: str = ""
    severities: list[str] = field(default_factory=list)
    min_severity: str | None = None  # include this severity and more severe
    resource_ids: list[uuid.UUID] = field(default_factory=list)
    hosts: list[str] = field(default_factory=list)
    applications: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    environment: str | None = None
    trace_id: str | None = None
    attributes: dict[str, str] = field(default_factory=dict)


def tokenize_query(text: str) -> tuple[list[str], list[str]]:
    """Split a search string into (alnum tokens, phrases). Quoted text is a phrase."""
    tokens: list[str] = []
    phrases: list[str] = []
    for m in re.finditer(r'"([^"]+)"|(\S+)', text or ""):
        if m.group(1):
            phrases.append(m.group(1))
        else:
            word = m.group(2)
            (tokens if _ALNUM.match(word) else phrases).append(word.lower() if _ALNUM.match(word) else word)
    return tokens[:20], phrases[:10]


def encode_cursor(ts: datetime, row_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{row_id}".encode()).decode()


def decode_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    if not cursor:
        return None
    try:
        ts_s, id_s = base64.urlsafe_b64decode(cursor.encode()).decode().split("|", 1)
        ts = datetime.fromisoformat(ts_s)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        return ts, uuid.UUID(id_s)
    except Exception:
        return None


class TelemetryStore(Protocol):
    async def insert(self, table: str, rows: list[dict[str, Any]]) -> None: ...
    async def ping(self) -> bool: ...
    async def metric_series(self, org_id: uuid.UUID, resource_ids: list[uuid.UUID], metric: str,
                            instance: str | None, start: datetime, end: datetime, step: int,
                            agg: str = "avg") -> list[dict[str, Any]]: ...
    async def metric_latest(self, org_id: uuid.UUID, resource_id: uuid.UUID) -> list[dict[str, Any]]: ...
    async def metric_aggregate(self, org_id: uuid.UUID, resource_ids: list[uuid.UUID], metric: str,
                               instance: str | None, agg: str, start: datetime,
                               end: datetime) -> dict[tuple[uuid.UUID, str], float]: ...
    async def metric_names(self, org_id: uuid.UUID, resource_id: uuid.UUID) -> list[dict[str, str]]: ...
    async def check_results(self, org_id: uuid.UUID, check_id: uuid.UUID, start: datetime, end: datetime,
                            limit: int = 500, statuses: list[str] | None = None) -> list[dict[str, Any]]: ...
    async def check_stats(self, org_id: uuid.UUID, check_ids: list[uuid.UUID], start: datetime,
                          end: datetime) -> dict[uuid.UUID, dict[str, Any]]: ...
    async def check_buckets(self, org_id: uuid.UUID, check_ids: list[uuid.UUID], start: datetime, end: datetime,
                            bucket_seconds: int) -> list[dict[str, Any]]: ...
    async def search_logs(self, org_id: uuid.UUID, q: LogQuery, limit: int,
                          cursor: str | None) -> tuple[list[dict[str, Any]], str | None]: ...
    async def log_histogram(self, org_id: uuid.UUID, q: LogQuery, bucket_seconds: int) -> list[dict[str, Any]]: ...
    async def count_logs(self, org_id: uuid.UUID, q: LogQuery) -> int: ...
    async def log_facets(self, org_id: uuid.UUID, q: LogQuery, field_name: str, limit: int = 20) -> list[dict[str, Any]]: ...
    async def events(self, org_id: uuid.UUID, start: datetime, end: datetime, resource_id: uuid.UUID | None = None,
                     kinds: list[str] | None = None, limit: int = 200) -> list[dict[str, Any]]: ...
    async def storage_stats(self) -> list[dict[str, Any]]: ...


def _norm_agg(agg: str) -> str:
    if agg not in AGGREGATIONS:
        raise ValueError(f"unsupported aggregation {agg!r}")
    return agg


# ============================================================================================
# ClickHouse implementation
# ============================================================================================

_CH_AGG = {
    "avg": "avg(value)", "min": "min(value)", "max": "max(value)", "sum": "sum(value)",
    "last": "argMax(value, ts)", "p95": "quantile(0.95)(value)", "p99": "quantile(0.99)(value)",
    "count": "toFloat64(count())",
}

_LOG_COLUMNS = ("ts", "id", "resource_id", "host", "application", "service", "source", "environment", "severity",
                "message", "trace_id", "attributes")

_COLUMNS: dict[str, tuple[str, ...]] = {
    "metrics": ("ts", "org_id", "resource_id", "metric", "instance", "value", "source", "retention_days"),
    "check_results": ("scheduled_at", "executed_at", "org_id", "check_id", "resource_id", "check_type", "status",
                      "latency_ms", "dns_ms", "connect_ms", "tls_ms", "ttfb_ms", "http_status", "message", "details",
                      "in_maintenance", "worker", "retention_days"),
    "logs": ("ts", "id", "org_id", "resource_id", "host", "application", "service", "source", "environment",
             "severity", "severity_num", "message", "trace_id", "attributes", "retention_days"),
    "events": ("ts", "id", "org_id", "resource_id", "kind", "severity", "title", "message", "data"),
}
_DEFAULTS: dict[str, Any] = {
    "instance": "", "source": "", "retention_days": 90, "dns_ms": None, "connect_ms": None, "tls_ms": None,
    "ttfb_ms": None, "latency_ms": None, "http_status": 0, "message": "", "details": "{}", "in_maintenance": 0,
    "worker": "", "resource_id": ZERO_UUID, "host": "", "application": "", "service": "", "environment": "",
    "severity": "info", "severity_num": 6, "trace_id": "", "attributes": {}, "data": "{}", "title": "",
}


def _log_where(q: LogQuery, params: dict[str, Any]) -> str:
    clauses = ["org_id = {org:UUID}", "ts >= {start:DateTime64(6)}", "ts < {end:DateTime64(6)}"]
    params["start"] = q.start
    params["end"] = q.end
    tokens, phrases = tokenize_query(q.text)
    for i, t in enumerate(tokens):
        params[f"tok{i}"] = t
        clauses.append(f"hasToken(lower(message), {{tok{i}:String}})")
    for i, p in enumerate(phrases):
        params[f"ph{i}"] = p
        clauses.append(f"positionCaseInsensitiveUTF8(message, {{ph{i}:String}}) > 0")
    if q.severities:
        params["sev"] = list(q.severities)
        clauses.append("severity IN {sev:Array(String)}")
    if q.min_severity:
        params["minsev"] = SEVERITY_NUM.get(q.min_severity, 7)
        clauses.append("severity_num <= {minsev:UInt8}")
    for name, col in (("hosts", "host"), ("applications", "application"), ("services", "service"),
                      ("sources", "source")):
        vals = getattr(q, name)
        if vals:
            params[name] = list(vals)
            clauses.append(f"{col} IN {{{name}:Array(String)}}")
    if q.resource_ids:
        params["rids"] = [str(r) for r in q.resource_ids]
        clauses.append("resource_id IN {rids:Array(UUID)}")
    if q.environment:
        params["env"] = q.environment
        clauses.append("environment = {env:String}")
    if q.trace_id:
        params["trace"] = q.trace_id
        clauses.append("trace_id = {trace:String}")
    for i, (k, v) in enumerate(list(q.attributes.items())[:10]):
        params[f"ak{i}"] = k
        params[f"av{i}"] = v
        clauses.append(f"attributes[{{ak{i}:String}}] = {{av{i}:String}}")
    return " AND ".join(clauses)


class ClickHouseStore:
    def __init__(self) -> None:
        self._client: Any = None
        self._lock = asyncio.Lock()

    async def _get(self) -> Any:
        if self._client is None:
            async with self._lock:
                if self._client is None:
                    import clickhouse_connect

                    s = get_settings()
                    self._client = await clickhouse_connect.get_async_client(
                        host=s.clickhouse_host,
                        port=s.clickhouse_port,
                        username=s.clickhouse_user,
                        password=s.clickhouse_password.get_secret_value(),
                        database=s.clickhouse_database,
                        secure=s.clickhouse_secure,
                        settings={"max_execution_time": s.clickhouse_query_timeout_s},
                        connect_timeout=5,
                        send_receive_timeout=s.clickhouse_query_timeout_s + 5,
                    )
        return self._client

    async def _query(self, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        client = await self._get()
        result = await client.query(sql, parameters=params, settings={"max_result_rows": get_settings().clickhouse_max_rows + 1, "result_overflow_mode": "break"})
        cols = result.column_names
        return [dict(zip(cols, row, strict=True)) for row in result.result_rows]

    async def ping(self) -> bool:
        try:
            client = await self._get()
            return bool(await client.ping())
        except Exception:
            return False

    async def insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if table not in _COLUMNS or not rows:
            return
        cols = _COLUMNS[table]
        data = [[r.get(c, _DEFAULTS.get(c)) for c in cols] for r in rows]
        client = await self._get()
        await client.insert(table, data, column_names=list(cols))

    async def metric_series(self, org_id, resource_ids, metric, instance, start, end, step, agg="avg"):
        expr = _CH_AGG[_norm_agg(agg)]
        params: dict[str, Any] = {
            "org": str(org_id), "rids": [str(r) for r in resource_ids], "metric": metric,
            "start": start, "end": end, "step": max(1, int(step)),
        }
        inst = ""
        if instance is not None:
            params["inst"] = instance
            inst = " AND instance = {inst:String}"
        sql = (
            "SELECT resource_id, instance, toStartOfInterval(ts, toIntervalSecond({step:UInt32})) AS bucket, "
            f"{expr} AS value FROM metrics WHERE org_id = {{org:UUID}} AND resource_id IN {{rids:Array(UUID)}} "
            "AND metric = {metric:String} AND ts >= {start:DateTime64(3)} AND ts < {end:DateTime64(3)}"
            f"{inst} GROUP BY resource_id, instance, bucket ORDER BY bucket LIMIT 20000"
        )
        rows = await self._query(sql, params)
        return [{"resource_id": r["resource_id"], "instance": r["instance"], "ts": r["bucket"], "value": r["value"]}
                for r in rows]

    async def metric_latest(self, org_id, resource_id):
        sql = (
            "SELECT metric, instance, argMax(value, ts) AS value, max(ts) AS ts FROM metrics "
            "WHERE org_id = {org:UUID} AND resource_id = {rid:UUID} AND ts >= now64(3) - INTERVAL 1 DAY "
            "GROUP BY metric, instance ORDER BY metric, instance LIMIT 5000"
        )
        return await self._query(sql, {"org": str(org_id), "rid": str(resource_id)})

    async def metric_aggregate(self, org_id, resource_ids, metric, instance, agg, start, end):
        expr = _CH_AGG[_norm_agg(agg)]
        params: dict[str, Any] = {"org": str(org_id), "rids": [str(r) for r in resource_ids], "metric": metric,
                                  "start": start, "end": end}
        inst = ""
        if instance is not None:
            params["inst"] = instance
            inst = " AND instance = {inst:String}"
        sql = (
            f"SELECT resource_id, instance, {expr} AS value FROM metrics WHERE org_id = {{org:UUID}} "
            "AND resource_id IN {rids:Array(UUID)} AND metric = {metric:String} "
            f"AND ts >= {{start:DateTime64(3)}} AND ts < {{end:DateTime64(3)}}{inst} GROUP BY resource_id, instance"
        )
        rows = await self._query(sql, params)
        return {(uuid.UUID(str(r["resource_id"])), r["instance"]): float(r["value"]) for r in rows}

    async def metric_names(self, org_id, resource_id):
        sql = ("SELECT DISTINCT metric, instance FROM metrics WHERE org_id = {org:UUID} AND resource_id = {rid:UUID} "
               "AND ts >= now64(3) - INTERVAL 7 DAY ORDER BY metric, instance LIMIT 2000")
        return await self._query(sql, {"org": str(org_id), "rid": str(resource_id)})

    async def check_results(self, org_id, check_id, start, end, limit=500, statuses=None):
        params: dict[str, Any] = {"org": str(org_id), "cid": str(check_id), "start": start, "end": end,
                                  "lim": min(limit, 5000)}
        st = ""
        if statuses:
            params["st"] = statuses
            st = " AND status IN {st:Array(String)}"
        sql = (
            "SELECT scheduled_at, executed_at, status, latency_ms, dns_ms, connect_ms, tls_ms, ttfb_ms, http_status, "
            "message, details, in_maintenance FROM check_results FINAL WHERE org_id = {org:UUID} "
            "AND check_id = {cid:UUID} AND scheduled_at >= {start:DateTime64(3)} AND scheduled_at < {end:DateTime64(3)}"
            f"{st} ORDER BY scheduled_at DESC LIMIT {{lim:UInt32}}"
        )
        rows = await self._query(sql, params)
        for r in rows:
            r["details"] = _json_or_empty(r.get("details"))
        return rows

    async def check_stats(self, org_id, check_ids, start, end):
        if not check_ids:
            return {}
        sql = (
            "SELECT check_id, "
            "countIf(status='up' AND in_maintenance=0) AS up, countIf(status='degraded' AND in_maintenance=0) AS degraded, "
            "countIf(status='down' AND in_maintenance=0) AS down, countIf(status='unknown' AND in_maintenance=0) AS unknown, "
            "countIf(status='skipped') AS skipped, countIf(in_maintenance=1 AND status!='skipped') AS maintenance, "
            "countIf(status='down' AND in_maintenance=1) AS maintenance_down, "
            "avgIf(latency_ms, status IN ('up','degraded')) AS avg_ms, minIf(latency_ms, status IN ('up','degraded')) AS min_ms, "
            "maxIf(latency_ms, status IN ('up','degraded')) AS max_ms, "
            "quantilesIf(0.5, 0.95, 0.99)(latency_ms, status IN ('up','degraded')) AS q "
            "FROM check_results FINAL WHERE org_id = {org:UUID} AND check_id IN {cids:Array(UUID)} "
            "AND scheduled_at >= {start:DateTime64(3)} AND scheduled_at < {end:DateTime64(3)} GROUP BY check_id"
        )
        rows = await self._query(sql, {"org": str(org_id), "cids": [str(c) for c in check_ids], "start": start, "end": end})
        out: dict[uuid.UUID, dict[str, Any]] = {}
        for r in rows:
            q = r.pop("q") or [None, None, None]
            cid = uuid.UUID(str(r.pop("check_id")))
            out[cid] = {**{k: (_nan_none(v)) for k, v in r.items()}, "p50_ms": _nan_none(q[0]), "p95_ms": _nan_none(q[1]),
                        "p99_ms": _nan_none(q[2])}
        return out

    async def check_buckets(self, org_id, check_ids, start, end, bucket_seconds):
        if not check_ids:
            return []
        sql = (
            "SELECT toStartOfInterval(scheduled_at, toIntervalSecond({b:UInt32})) AS bucket, "
            "countIf(status='up' AND in_maintenance=0) AS up, countIf(status='degraded' AND in_maintenance=0) AS degraded, "
            "countIf(status='down' AND in_maintenance=0) AS down, countIf(status IN ('unknown','skipped') AND in_maintenance=0) AS unknown, "
            "countIf(in_maintenance=1) AS maintenance, avgIf(latency_ms, status IN ('up','degraded')) AS avg_ms "
            "FROM check_results FINAL WHERE org_id = {org:UUID} AND check_id IN {cids:Array(UUID)} "
            "AND scheduled_at >= {start:DateTime64(3)} AND scheduled_at < {end:DateTime64(3)} GROUP BY bucket ORDER BY bucket"
        )
        rows = await self._query(sql, {"org": str(org_id), "cids": [str(c) for c in check_ids], "start": start, "end": end,
                                       "b": max(60, int(bucket_seconds))})
        for r in rows:
            r["avg_ms"] = _nan_none(r.get("avg_ms"))
        return rows

    async def search_logs(self, org_id, q, limit, cursor):
        params: dict[str, Any] = {"org": str(org_id), "lim": min(max(1, limit), 1000) + 1}
        where = _log_where(q, params)
        c = decode_cursor(cursor)
        if c:
            params["cts"], params["cid"] = c[0], str(c[1])
            where += " AND (ts, id) < ({cts:DateTime64(6)}, {cid:UUID})"
        sql = f"SELECT {', '.join(_LOG_COLUMNS)} FROM logs WHERE {where} ORDER BY ts DESC, id DESC LIMIT {{lim:UInt32}}"
        rows = await self._query(sql, params)
        nxt = None
        if len(rows) > params["lim"] - 1:
            rows = rows[: params["lim"] - 1]
            last = rows[-1]
            nxt = encode_cursor(last["ts"], uuid.UUID(str(last["id"])))
        return rows, nxt

    async def log_histogram(self, org_id, q, bucket_seconds):
        params: dict[str, Any] = {"org": str(org_id), "b": max(1, int(bucket_seconds))}
        where = _log_where(q, params)
        sql = (f"SELECT toStartOfInterval(ts, toIntervalSecond({{b:UInt32}})) AS bucket, severity, count() AS count "
               f"FROM logs WHERE {where} GROUP BY bucket, severity ORDER BY bucket LIMIT 50000")
        return await self._query(sql, params)

    async def count_logs(self, org_id, q):
        params: dict[str, Any] = {"org": str(org_id)}
        where = _log_where(q, params)
        rows = await self._query(f"SELECT count() AS c FROM logs WHERE {where}", params)
        return int(rows[0]["c"]) if rows else 0

    async def log_facets(self, org_id, q, field_name, limit=20):
        if field_name not in ("host", "application", "service", "source", "severity", "environment"):
            raise ValueError("unsupported facet")
        params: dict[str, Any] = {"org": str(org_id), "lim": min(limit, 100)}
        where = _log_where(q, params)
        sql = (f"SELECT {field_name} AS value, count() AS count FROM logs WHERE {where} GROUP BY value "
               "ORDER BY count DESC LIMIT {lim:UInt32}")
        return await self._query(sql, params)

    async def events(self, org_id, start, end, resource_id=None, kinds=None, limit=200):
        params: dict[str, Any] = {"org": str(org_id), "start": start, "end": end, "lim": min(limit, 2000)}
        extra = ""
        if resource_id:
            params["rid"] = str(resource_id)
            extra += " AND resource_id = {rid:UUID}"
        if kinds:
            params["kinds"] = kinds
            extra += " AND kind IN {kinds:Array(String)}"
        sql = ("SELECT ts, id, resource_id, kind, severity, title, message, data FROM events WHERE org_id = {org:UUID} "
               f"AND ts >= {{start:DateTime64(3)}} AND ts < {{end:DateTime64(3)}}{extra} ORDER BY ts DESC LIMIT {{lim:UInt32}}")
        rows = await self._query(sql, params)
        for r in rows:
            r["data"] = _json_or_empty(r.get("data"))
        return rows

    async def storage_stats(self):
        sql = ("SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes, min(min_time) AS oldest "
               "FROM system.parts WHERE active AND database = {db:String} GROUP BY table ORDER BY table")
        return await self._query(sql, {"db": get_settings().clickhouse_database})


def _nan_none(v: Any) -> Any:
    if isinstance(v, float) and v != v:  # NaN
        return None
    return v


def _json_or_empty(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v or "{}")
        except ValueError:
            return {}
    return v or {}


# ============================================================================================
# In-memory implementation (tests / single-process development only)
# ============================================================================================


def _as_dt(v: Any) -> datetime:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=UTC)
    return datetime.fromisoformat(str(v))


def _uuid(v: Any) -> uuid.UUID:
    return v if isinstance(v, uuid.UUID) else uuid.UUID(str(v))


def _bucket(ts: datetime, step: int) -> datetime:
    epoch = int(ts.timestamp())
    return datetime.fromtimestamp(epoch - epoch % step, UTC)


def _agg(values: list[float], agg: str, tss: list[datetime] | None = None) -> float:
    if agg == "avg":
        return sum(values) / len(values)
    if agg == "min":
        return min(values)
    if agg == "max":
        return max(values)
    if agg == "sum":
        return float(sum(values))
    if agg == "count":
        return float(len(values))
    if agg == "last":
        assert tss is not None
        return values[max(range(len(values)), key=lambda i: tss[i])]
    if agg in ("p95", "p99"):
        return _quantile(values, 0.95 if agg == "p95" else 0.99)
    raise ValueError(agg)


def _quantile(values: list[float], q: float) -> float:
    s = sorted(values)
    if not s:
        return float("nan")
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


class MemoryStore:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = defaultdict(list)

    def clear(self) -> None:
        self.tables.clear()

    async def ping(self) -> bool:
        return True

    async def insert(self, table: str, rows: list[dict[str, Any]]) -> None:
        if table not in _COLUMNS:
            return
        for r in rows:
            row = {c: r.get(c, _DEFAULTS.get(c)) for c in _COLUMNS[table]}
            for k in ("ts", "scheduled_at", "executed_at"):
                if k in row and row[k] is not None:
                    row[k] = _as_dt(row[k])
            for k in ("org_id", "resource_id", "check_id", "id"):
                if k in row and row[k] is not None:
                    row[k] = _uuid(row[k])
            if table == "check_results":
                # ReplacingMergeTree(executed_at) semantics on (org, check, scheduled_at)
                existing = self.tables[table]
                key = (row["org_id"], row["check_id"], row["scheduled_at"])
                for i, e in enumerate(existing):
                    if (e["org_id"], e["check_id"], e["scheduled_at"]) == key:
                        if row["executed_at"] >= e["executed_at"]:
                            existing[i] = row
                        break
                else:
                    existing.append(row)
            else:
                self.tables[table].append(row)

    def _metrics(self, org_id, resource_ids, metric, instance, start, end):
        rids = {_uuid(r) for r in resource_ids}
        for r in self.tables["metrics"]:
            if (r["org_id"] == org_id and r["resource_id"] in rids and r["metric"] == metric
                    and start <= r["ts"] < end and (instance is None or r["instance"] == instance)):
                yield r

    async def metric_series(self, org_id, resource_ids, metric, instance, start, end, step, agg="avg"):
        _norm_agg(agg)
        groups: dict[tuple, tuple[list[float], list[datetime]]] = defaultdict(lambda: ([], []))
        for r in self._metrics(org_id, resource_ids, metric, instance, start, end):
            g = groups[(r["resource_id"], r["instance"], _bucket(r["ts"], max(1, int(step))))]
            g[0].append(r["value"])
            g[1].append(r["ts"])
        out = [{"resource_id": k[0], "instance": k[1], "ts": k[2], "value": _agg(v, agg, t)} for k, (v, t) in groups.items()]
        return sorted(out, key=lambda x: x["ts"])

    async def metric_latest(self, org_id, resource_id):
        latest: dict[tuple[str, str], dict[str, Any]] = {}
        cutoff = datetime.now(UTC) - timedelta(days=1)
        for r in self.tables["metrics"]:
            if r["org_id"] == org_id and r["resource_id"] == _uuid(resource_id) and r["ts"] >= cutoff:
                k = (r["metric"], r["instance"])
                if k not in latest or r["ts"] >= latest[k]["ts"]:
                    latest[k] = {"metric": r["metric"], "instance": r["instance"], "value": r["value"], "ts": r["ts"]}
        return [latest[k] for k in sorted(latest)]

    async def metric_aggregate(self, org_id, resource_ids, metric, instance, agg, start, end):
        _norm_agg(agg)
        groups: dict[tuple, tuple[list[float], list[datetime]]] = defaultdict(lambda: ([], []))
        for r in self._metrics(org_id, resource_ids, metric, instance, start, end):
            g = groups[(r["resource_id"], r["instance"])]
            g[0].append(r["value"])
            g[1].append(r["ts"])
        return {k: _agg(v, agg, t) for k, (v, t) in groups.items()}

    async def metric_names(self, org_id, resource_id):
        seen = sorted({(r["metric"], r["instance"]) for r in self.tables["metrics"]
                       if r["org_id"] == org_id and r["resource_id"] == _uuid(resource_id)})
        return [{"metric": m, "instance": i} for m, i in seen]

    def _results(self, org_id, check_ids, start, end):
        cids = {_uuid(c) for c in check_ids}
        return [r for r in self.tables["check_results"]
                if r["org_id"] == org_id and r["check_id"] in cids and start <= r["scheduled_at"] < end]

    async def check_results(self, org_id, check_id, start, end, limit=500, statuses=None):
        rows = [dict(r) for r in self._results(org_id, [check_id], start, end) if not statuses or r["status"] in statuses]
        rows.sort(key=lambda r: r["scheduled_at"], reverse=True)
        for r in rows:
            r["details"] = _json_or_empty(r.get("details"))
        return rows[: min(limit, 5000)]

    async def check_stats(self, org_id, check_ids, start, end):
        out: dict[uuid.UUID, dict[str, Any]] = {}
        by: dict[uuid.UUID, list[dict[str, Any]]] = defaultdict(list)
        for r in self._results(org_id, check_ids, start, end):
            by[r["check_id"]].append(r)
        for cid, rows in by.items():
            def cnt(pred) -> int:
                return sum(1 for r in rows if pred(r))
            lat = [r["latency_ms"] for r in rows if r["status"] in ("up", "degraded") and r["latency_ms"] is not None]
            out[cid] = {
                "up": cnt(lambda r: r["status"] == "up" and not r["in_maintenance"]),
                "degraded": cnt(lambda r: r["status"] == "degraded" and not r["in_maintenance"]),
                "down": cnt(lambda r: r["status"] == "down" and not r["in_maintenance"]),
                "unknown": cnt(lambda r: r["status"] == "unknown" and not r["in_maintenance"]),
                "skipped": cnt(lambda r: r["status"] == "skipped"),
                "maintenance": cnt(lambda r: r["in_maintenance"] and r["status"] != "skipped"),
                "maintenance_down": cnt(lambda r: r["status"] == "down" and r["in_maintenance"]),
                "avg_ms": sum(lat) / len(lat) if lat else None,
                "min_ms": min(lat) if lat else None,
                "max_ms": max(lat) if lat else None,
                "p50_ms": _quantile(lat, 0.5) if lat else None,
                "p95_ms": _quantile(lat, 0.95) if lat else None,
                "p99_ms": _quantile(lat, 0.99) if lat else None,
            }
        return out

    async def check_buckets(self, org_id, check_ids, start, end, bucket_seconds):
        step = max(60, int(bucket_seconds))
        by: dict[datetime, dict[str, Any]] = {}
        lat: dict[datetime, list[float]] = defaultdict(list)
        for r in self._results(org_id, check_ids, start, end):
            b = _bucket(r["scheduled_at"], step)
            d = by.setdefault(b, {"bucket": b, "up": 0, "degraded": 0, "down": 0, "unknown": 0, "maintenance": 0})
            if r["in_maintenance"]:
                d["maintenance"] += 1
            elif r["status"] in ("unknown", "skipped"):
                d["unknown"] += 1
            else:
                d[r["status"]] += 1
            if r["status"] in ("up", "degraded") and not r["in_maintenance"] and r["latency_ms"] is not None:
                lat[b].append(r["latency_ms"])
        for b, d in by.items():
            d["avg_ms"] = sum(lat[b]) / len(lat[b]) if lat[b] else None
        return [by[b] for b in sorted(by)]

    def _log_match(self, org_id: uuid.UUID, q: LogQuery, r: dict[str, Any]) -> bool:
        if r["org_id"] != org_id or not (q.start <= r["ts"] < q.end):
            return False
        tokens, phrases = tokenize_query(q.text)
        if tokens:
            words = set(re.split(r"[^a-z0-9]+", r["message"].lower()))
            if not all(t in words for t in tokens):
                return False
        if any(p.lower() not in r["message"].lower() for p in phrases):
            return False
        if q.severities and r["severity"] not in q.severities:
            return False
        if q.min_severity and r["severity_num"] > SEVERITY_NUM.get(q.min_severity, 7):
            return False
        for name, col in (("hosts", "host"), ("applications", "application"), ("services", "service"),
                          ("sources", "source")):
            vals = getattr(q, name)
            if vals and r[col] not in vals:
                return False
        if q.resource_ids and r["resource_id"] not in {_uuid(x) for x in q.resource_ids}:
            return False
        if q.environment and r["environment"] != q.environment:
            return False
        if q.trace_id and r["trace_id"] != q.trace_id:
            return False
        return all((r["attributes"] or {}).get(k) == v for k, v in q.attributes.items())

    async def search_logs(self, org_id, q, limit, cursor):
        rows = [r for r in self.tables["logs"] if self._log_match(org_id, q, r)]
        rows.sort(key=lambda r: (r["ts"], r["id"]), reverse=True)
        c = decode_cursor(cursor)
        if c:
            keys = [(-r["ts"].timestamp(), -r["id"].int) for r in rows]
            idx = bisect.bisect_right(keys, (-c[0].timestamp(), -c[1].int))
            rows = rows[idx:]
        lim = min(max(1, limit), 1000)
        page = [{k: r[k] for k in _LOG_COLUMNS} for r in rows[:lim]]
        nxt = encode_cursor(page[-1]["ts"], page[-1]["id"]) if len(rows) > lim else None
        return page, nxt

    async def log_histogram(self, org_id, q, bucket_seconds):
        counts: dict[tuple[datetime, str], int] = defaultdict(int)
        for r in self.tables["logs"]:
            if self._log_match(org_id, q, r):
                counts[(_bucket(r["ts"], max(1, int(bucket_seconds))), r["severity"])] += 1
        return [{"bucket": b, "severity": s, "count": c} for (b, s), c in sorted(counts.items())]

    async def count_logs(self, org_id, q):
        return sum(1 for r in self.tables["logs"] if self._log_match(org_id, q, r))

    async def log_facets(self, org_id, q, field_name, limit=20):
        if field_name not in ("host", "application", "service", "source", "severity", "environment"):
            raise ValueError("unsupported facet")
        counts: dict[str, int] = defaultdict(int)
        for r in self.tables["logs"]:
            if self._log_match(org_id, q, r):
                counts[r[field_name]] += 1
        return [{"value": v, "count": c} for v, c in sorted(counts.items(), key=lambda x: -x[1])[:limit]]

    async def events(self, org_id, start, end, resource_id=None, kinds=None, limit=200):
        rows = [dict(r) for r in self.tables["events"] if r["org_id"] == org_id and start <= r["ts"] < end
                and (resource_id is None or r["resource_id"] == _uuid(resource_id)) and (not kinds or r["kind"] in kinds)]
        rows.sort(key=lambda r: r["ts"], reverse=True)
        for r in rows:
            r["data"] = _json_or_empty(r.get("data"))
            r.pop("org_id", None)
        return rows[:limit]

    async def storage_stats(self):
        return [{"table": t, "rows": len(self.tables.get(t, [])), "bytes": None, "oldest": None} for t in TABLES]


_store: TelemetryStore | None = None


def get_store() -> TelemetryStore:
    global _store
    if _store is None:
        import os

        backend = os.environ.get("EMONITOR_TELEMETRY_BACKEND", "clickhouse")
        if backend == "memory":
            if get_settings().is_production:
                raise RuntimeError("memory telemetry backend is not allowed in production")
            log.warning("Using in-memory telemetry store (development/test only)")
            _store = MemoryStore()
        else:
            _store = ClickHouseStore()
    return _store


def set_store(store: TelemetryStore | None) -> None:
    global _store
    _store = store
