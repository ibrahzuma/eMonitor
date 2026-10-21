"""Alert rule condition schemas (validated on create/update)."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import AlertRuleType

Operator = Literal["gt", "gte", "lt", "lte"]


class _C(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MetricThresholdCond(_C):
    metric: str = Field(min_length=1, max_length=100)
    instance: str | None = None  # None = evaluate every instance separately
    aggregation: Literal["avg", "min", "max", "p95", "p99", "last", "sum", "count"] = "avg"
    operator: Operator = "gt"
    threshold: float
    window_seconds: int = Field(default=300, ge=30, le=86400)


class ResponseTimeCond(_C):
    aggregation: Literal["avg", "p95", "p99", "max"] = "avg"
    operator: Operator = "gt"
    threshold_ms: float = Field(gt=0)
    window_seconds: int = Field(default=300, ge=60, le=86400)


class ConsecutiveFailuresCond(_C):
    failures: int = Field(default=3, ge=1, le=1000)


class WebsiteDownCond(_C):
    pass


class SslExpiryCond(_C):
    days: int = Field(default=14, ge=0, le=365)


class LogPatternCond(_C):
    query: str = Field(default="", max_length=500)
    severities: list[str] = Field(default_factory=list)
    min_severity: str | None = None
    applications: list[str] = Field(default_factory=list)
    services: list[str] = Field(default_factory=list)
    operator: Operator = "gte"
    threshold: int = Field(default=1, ge=0)
    window_seconds: int = Field(default=300, ge=60, le=86400)
    per_resource: bool = False


class ErrorRateCond(_C):
    source: Literal["logs", "checks"] = "logs"
    threshold_percent: float = Field(gt=0, le=100)
    min_events: int = Field(default=10, ge=1)
    window_seconds: int = Field(default=300, ge=60, le=86400)
    applications: list[str] = Field(default_factory=list)


class MissingTelemetryCond(_C):
    metric: str = Field(default="cpu_percent", max_length=100)
    window_seconds: int = Field(default=300, ge=60, le=86400)


class AgentDisconnectedCond(_C):
    seconds: int = Field(default=300, ge=30, le=86400)


class CompositeCond(_C):
    operator: Literal["and", "or"] = "and"
    rule_ids: list[uuid.UUID] = Field(min_length=2, max_length=10)


CONDITIONS: dict[str, type[_C]] = {
    AlertRuleType.METRIC_THRESHOLD: MetricThresholdCond,
    AlertRuleType.RESPONSE_TIME: ResponseTimeCond,
    AlertRuleType.CONSECUTIVE_FAILURES: ConsecutiveFailuresCond,
    AlertRuleType.WEBSITE_DOWN: WebsiteDownCond,
    AlertRuleType.SSL_EXPIRY: SslExpiryCond,
    AlertRuleType.LOG_PATTERN: LogPatternCond,
    AlertRuleType.ERROR_RATE: ErrorRateCond,
    AlertRuleType.MISSING_TELEMETRY: MissingTelemetryCond,
    AlertRuleType.AGENT_DISCONNECTED: AgentDisconnectedCond,
    AlertRuleType.COMPOSITE: CompositeCond,
}


class RuleTarget(_C):
    resource_ids: list[uuid.UUID] = Field(default_factory=list)
    group_ids: list[uuid.UUID] = Field(default_factory=list)
    check_ids: list[uuid.UUID] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    kinds: list[str] = Field(default_factory=list)
    environments: list[str] = Field(default_factory=list)


def parse_condition(rule_type: str, condition: dict[str, Any]) -> _C:
    model = CONDITIONS.get(rule_type)
    if model is None:
        raise ValueError(f"unknown rule type {rule_type}")
    return model.model_validate(condition)


def compare(value: float, op: str, threshold: float) -> bool:
    return {"gt": value > threshold, "gte": value >= threshold, "lt": value < threshold,
            "lte": value <= threshold}[op]
