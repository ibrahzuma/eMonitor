from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.alerts.evaluator import observe
from app.alerts.rules import CompositeCond, RuleTarget, parse_condition
from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Permission
from app.models import AlertRule, AlertRuleState, NotificationPolicy
from app.models.enums import AlertRuleType, Severity
from app.schemas.common import ORM, Message
from app.services import audit

router = APIRouter(prefix="/alerts", tags=["alerts"])


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    rule_type: AlertRuleType
    target: dict[str, Any] = Field(default_factory=dict)
    condition: dict[str, Any] = Field(default_factory=dict)
    severity: Severity = Severity.WARNING
    evaluation_interval_seconds: int = Field(default=60, ge=15, le=86400)
    consecutive_breaches: int = Field(default=1, ge=1, le=100)
    recovery_consecutive: int = Field(default=1, ge=1, le=100)
    cooldown_seconds: int = Field(default=300, ge=0, le=86400)
    suppress_in_maintenance: bool = True
    auto_resolve: bool = True
    notification_policy_id: uuid.UUID | None = None
    enabled: bool = True


class RuleOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    rule_type: str
    target: dict[str, Any]
    condition: dict[str, Any]
    severity: str
    evaluation_interval_seconds: int
    consecutive_breaches: int
    recovery_consecutive: int
    cooldown_seconds: int
    suppress_in_maintenance: bool
    auto_resolve: bool
    notification_policy_id: uuid.UUID | None
    enabled: bool
    last_eval_at: datetime | None
    last_error: str
    created_at: datetime
    firing: int = 0


class RuleStateOut(ORM):
    subject_key: str
    state: str
    breaches: int
    oks: int
    last_value: float | None
    last_fired_at: datetime | None
    last_resolved_at: datetime | None
    updated_at: datetime


async def _validate(db: AsyncSession, ctx: Ctx, body: RuleIn, rule_id: uuid.UUID | None = None) -> tuple[dict, dict]:
    try:
        cond = parse_condition(body.rule_type, body.condition)
        target = RuleTarget.model_validate(body.target)
    except ValidationError as exc:
        raise ValidationFailed("invalid rule", details=[{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]) \
            from None
    if isinstance(cond, CompositeCond):
        if rule_id and rule_id in cond.rule_ids:
            raise ValidationFailed("a composite rule cannot reference itself")
        found = set((await db.scalars(select(AlertRule.id).where(AlertRule.organization_id == ctx.org_id,
                                                                 AlertRule.id.in_(cond.rule_ids)))).all())
        if found != set(cond.rule_ids):
            raise ValidationFailed("composite rule references unknown rules")
    if body.notification_policy_id and not await db.scalar(select(NotificationPolicy.id).where(
            NotificationPolicy.id == body.notification_policy_id, NotificationPolicy.organization_id == ctx.org_id)):
        raise ValidationFailed("notification policy not found")
    return cond.model_dump(mode="json"), target.model_dump(mode="json")


async def _firing_counts(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    from sqlalchemy import func

    if not ids:
        return {}
    rows = await db.execute(select(AlertRuleState.rule_id, func.count()).where(
        AlertRuleState.rule_id.in_(ids), AlertRuleState.state == "firing").group_by(AlertRuleState.rule_id))
    return dict(rows.all())


@router.get("/rules", response_model=list[RuleOut])
async def list_rules(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    rules = (await db.scalars(select(AlertRule).where(AlertRule.organization_id == ctx.org_id)
                              .order_by(AlertRule.name))).all()
    counts = await _firing_counts(db, [r.id for r in rules])
    out = []
    for r in rules:
        o = RuleOut.model_validate(r)
        o.firing = counts.get(r.id, 0)
        out.append(o)
    return out


@router.post("/rules", response_model=RuleOut, status_code=201)
async def create_rule(body: RuleIn, ctx: Ctx = Depends(require(Permission.ALERTS_MANAGE)),
                      db: AsyncSession = Depends(get_db)):
    cond, target = await _validate(db, ctx, body)
    rule = AlertRule(organization_id=ctx.org_id, **body.model_dump(exclude={"condition", "target"}), condition=cond,
                     target=target, next_eval_at=datetime.now(UTC))
    db.add(rule)
    await db.flush()
    audit.record(db, action="alert_rule.created", ctx=ctx, target_type="alert_rule", target_id=rule.id,
                 details={"name": rule.name, "type": rule.rule_type})
    await db.commit()
    return RuleOut.model_validate(rule)


async def _rule(db: AsyncSession, ctx: Ctx, rule_id: uuid.UUID) -> AlertRule:
    r = await db.scalar(select(AlertRule).where(AlertRule.id == rule_id, AlertRule.organization_id == ctx.org_id))
    if not r:
        raise NotFound("Alert rule")
    return r


@router.get("/rules/{rule_id}", response_model=RuleOut)
async def get_rule(rule_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    r = await _rule(db, ctx, rule_id)
    o = RuleOut.model_validate(r)
    o.firing = (await _firing_counts(db, [r.id])).get(r.id, 0)
    return o


@router.put("/rules/{rule_id}", response_model=RuleOut)
async def update_rule(rule_id: uuid.UUID, body: RuleIn, ctx: Ctx = Depends(require(Permission.ALERTS_MANAGE)),
                      db: AsyncSession = Depends(get_db)):
    rule = await _rule(db, ctx, rule_id)
    if body.rule_type != rule.rule_type:
        raise ValidationFailed("rule type cannot be changed; create a new rule")
    cond, target = await _validate(db, ctx, body, rule.id)
    for k, v in body.model_dump(exclude={"condition", "target"}).items():
        setattr(rule, k, v)
    rule.condition, rule.target = cond, target
    rule.next_eval_at = datetime.now(UTC)
    audit.record(db, action="alert_rule.updated", ctx=ctx, target_type="alert_rule", target_id=rule.id,
                 details=body.model_dump(mode="json"))
    await db.commit()
    return RuleOut.model_validate(rule)


@router.delete("/rules/{rule_id}", response_model=Message)
async def delete_rule(rule_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.ALERTS_MANAGE)),
                      db: AsyncSession = Depends(get_db)):
    rule = await _rule(db, ctx, rule_id)
    audit.record(db, action="alert_rule.deleted", ctx=ctx, target_type="alert_rule", target_id=rule.id,
                 details={"name": rule.name})
    await db.delete(rule)
    await db.commit()
    return Message(message="Alert rule deleted (open incidents it created remain until resolved)")


@router.get("/rules/{rule_id}/states", response_model=list[RuleStateOut])
async def rule_states(rule_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    await _rule(db, ctx, rule_id)
    return (await db.scalars(select(AlertRuleState).where(AlertRuleState.rule_id == rule_id)
                             .order_by(AlertRuleState.subject_key))).all()


@router.post("/rules/{rule_id}/preview")
async def preview_rule(rule_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    """Evaluate the rule's condition now without changing state or creating incidents."""
    rule = await _rule(db, ctx, rule_id)
    obs = await observe(db, ctx.org, rule, datetime.now(UTC))
    out = [{"subject": o.subject, "breached": o.breached, "value": o.value,
            "resource": o.resource.name if o.resource else None, "detail": o.detail} for o in obs]
    await db.rollback()
    return out
