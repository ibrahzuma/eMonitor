from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import Ctx, require
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Permission
from app.core.security import decrypt_json, encrypt_json
from app.models import InAppNotification, NotificationChannel, NotificationDelivery, NotificationPolicy, Team
from app.models.enums import ChannelType, DeliveryStatus, NotificationEvent, Severity
from app.monitoring import netguard
from app.notifications.providers import PROVIDERS
from app.notifications.templates import validate_template
from app.schemas.common import ORM, Message, Page, PageParams
from app.services import audit

router = APIRouter(prefix="/notifications", tags=["notifications"])


class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    type: ChannelType
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, Any] | None = None  # write-only
    enabled: bool = True
    rate_limit_per_hour: int = Field(default=60, ge=0, le=10000)


class ChannelOut(ORM):
    id: uuid.UUID
    name: str
    type: str
    config: dict[str, Any]
    secrets_configured: list[str] = []
    enabled: bool
    rate_limit_per_hour: int
    last_test_at: datetime | None
    last_test_ok: bool | None
    created_at: datetime


def _channel_out(ch: NotificationChannel) -> ChannelOut:
    o = ChannelOut.model_validate(ch)
    try:
        o.secrets_configured = sorted(k for k, v in decrypt_json(ch.secret_enc).items() if v)
    except RuntimeError:
        o.secrets_configured = []
    return o


def _validate_channel(ctx: Ctx, type_: str, config: dict[str, Any], secrets: dict[str, Any] | None) -> tuple[dict, dict | None]:
    provider = PROVIDERS[type_]
    try:
        cfg = provider.config_model.model_validate(config)
        sec = provider.secrets_model.model_validate(secrets or {}) if provider.secrets_model else None
    except ValidationError as exc:
        raise ValidationFailed("invalid channel configuration",
                               details=[{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]) from None
    if type_ == ChannelType.WEBHOOK:
        from urllib.parse import urlsplit

        host = urlsplit(cfg.url).hostname or ""  # type: ignore[attr-defined]
        try:
            netguard.static_validate(host, netguard.Scope.from_org(ctx.org.monitoring_scope))
        except netguard.TargetNotAllowed as exc:
            raise ValidationFailed(f"webhook target not allowed: {exc}") from None
    return cfg.model_dump(mode="json"), (sec.model_dump(exclude_none=True) if sec else None)


@router.get("/channels", response_model=list[ChannelOut])
async def list_channels(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    rows = (await db.scalars(select(NotificationChannel).where(NotificationChannel.organization_id == ctx.org_id)
                             .order_by(NotificationChannel.name))).all()
    return [_channel_out(c) for c in rows]


@router.post("/channels", response_model=ChannelOut, status_code=201)
async def create_channel(body: ChannelIn, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                         db: AsyncSession = Depends(get_db)):
    cfg, sec = _validate_channel(ctx, body.type, body.config, body.secrets)
    ch = NotificationChannel(organization_id=ctx.org_id, name=body.name, type=body.type, config=cfg,
                             secret_enc=encrypt_json(sec) if sec else None, enabled=body.enabled,
                             rate_limit_per_hour=body.rate_limit_per_hour)
    db.add(ch)
    await db.flush()
    audit.record(db, action="notification_channel.created", ctx=ctx, target_type="notification_channel",
                 target_id=ch.id, details={"name": ch.name, "type": ch.type, "config": cfg})
    await db.commit()
    return _channel_out(ch)


async def _channel(db: AsyncSession, ctx: Ctx, cid: uuid.UUID) -> NotificationChannel:
    ch = await db.scalar(select(NotificationChannel).where(NotificationChannel.id == cid,
                                                           NotificationChannel.organization_id == ctx.org_id))
    if not ch:
        raise NotFound("Notification channel")
    return ch


@router.put("/channels/{channel_id}", response_model=ChannelOut)
async def update_channel(channel_id: uuid.UUID, body: ChannelIn, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                         db: AsyncSession = Depends(get_db)):
    ch = await _channel(db, ctx, channel_id)
    if body.type != ch.type:
        raise ValidationFailed("channel type cannot be changed")
    old = decrypt_json(ch.secret_enc) if ch.secret_enc else {}
    merged = old if body.secrets is None else {k: v for k, v in {**old, **body.secrets}.items() if v not in ("", None)}
    cfg, sec = _validate_channel(ctx, body.type, body.config, merged)
    ch.name, ch.config, ch.enabled, ch.rate_limit_per_hour = body.name, cfg, body.enabled, body.rate_limit_per_hour
    ch.secret_enc = encrypt_json(sec) if sec else None
    audit.record(db, action="notification_channel.updated", ctx=ctx, target_type="notification_channel",
                 target_id=ch.id, details={"name": ch.name, "config": cfg, "secrets_changed": body.secrets is not None})
    await db.commit()
    return _channel_out(ch)


@router.delete("/channels/{channel_id}", response_model=Message)
async def delete_channel(channel_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                         db: AsyncSession = Depends(get_db)):
    ch = await _channel(db, ctx, channel_id)
    audit.record(db, action="notification_channel.deleted", ctx=ctx, target_type="notification_channel",
                 target_id=ch.id, details={"name": ch.name})
    await db.delete(ch)
    await db.commit()
    return Message(message="Channel deleted")


@router.post("/channels/{channel_id}/test", response_model=Message, status_code=202)
async def test_channel(channel_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                       db: AsyncSession = Depends(get_db)):
    """Queue a test message; the result appears in the delivery log and on the channel."""
    ch = await _channel(db, ctx, channel_id)
    now = datetime.now(UTC)
    d = NotificationDelivery(
        organization_id=ctx.org_id, channel_id=ch.id, channel_type=ch.type, event=NotificationEvent.TEST,
        dedup_key=f"test:{ch.id}:{uuid.uuid4()}", status=DeliveryStatus.PENDING, next_attempt_at=now, max_attempts=1,
        subject=f"[TEST] eMonitor notification channel '{ch.name}'",
        body="This is a test notification from eMonitor. If you received it, the channel is configured correctly.",
    )
    db.add(d)
    ch.last_test_at = now
    await db.flush()
    if ch.type == ChannelType.IN_APP and ctx.user_id:
        db.add(InAppNotification(organization_id=ctx.org_id, user_id=ctx.user_id, title=d.subject, body=d.body))
        d.status, d.sent_at, ch.last_test_ok = DeliveryStatus.SENT, now, True
    await db.commit()
    if d.status == DeliveryStatus.PENDING:
        from app.workers.dispatch import enqueue_delivery

        enqueue_delivery(d.id)
    return Message(message="Test notification queued; check the delivery log for the result")


# ---------------------------------------------------------------- policies

class StepIn(BaseModel):
    delay_minutes: int = Field(default=0, ge=0, le=10080)
    channel_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class QuietHours(BaseModel):
    enabled: bool = False
    start: str = Field(default="22:00", pattern=r"^\d{2}:\d{2}$")
    end: str = Field(default="07:00", pattern=r"^\d{2}:\d{2}$")
    timezone: str = "UTC"
    allow_critical: bool = True
    weekdays: list[int] = Field(default_factory=list)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        from zoneinfo import ZoneInfo

        ZoneInfo(v)
        return v


class PolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    is_default: bool = False
    min_severity: Severity = Severity.INFO
    team_ids: list[uuid.UUID] = Field(default_factory=list)
    steps: list[StepIn] = Field(min_length=1, max_length=10)
    notify_on_ack: bool = False
    notify_on_resolve: bool = True
    quiet_hours: QuietHours = Field(default_factory=QuietHours)
    templates: dict[str, str] = Field(default_factory=dict)
    priority: int = Field(default=100, ge=0, le=10000)
    enabled: bool = True


class PolicyOut(ORM):
    id: uuid.UUID
    name: str
    description: str
    is_default: bool
    min_severity: str
    team_ids: list[uuid.UUID]
    steps: list[dict[str, Any]]
    notify_on_ack: bool
    notify_on_resolve: bool
    quiet_hours: dict[str, Any]
    templates: dict[str, Any]
    priority: int
    enabled: bool
    created_at: datetime


async def _validate_policy(db: AsyncSession, ctx: Ctx, body: PolicyIn) -> dict[str, Any]:
    ids = {c for s in body.steps for c in s.channel_ids}
    found = set((await db.scalars(select(NotificationChannel.id).where(
        NotificationChannel.organization_id == ctx.org_id, NotificationChannel.id.in_(ids)))).all())
    if found != ids:
        raise ValidationFailed("policy references unknown channels")
    if body.team_ids:
        teams = set((await db.scalars(select(Team.id).where(Team.organization_id == ctx.org_id,
                                                            Team.id.in_(body.team_ids)))).all())
        if teams != set(body.team_ids):
            raise ValidationFailed("policy references unknown teams")
    for key in ("subject", "body"):
        if body.templates.get(key):
            err = validate_template(body.templates[key])
            if err:
                raise ValidationFailed(f"template {key} is invalid: {err}")
    unknown = set(body.templates) - {"subject", "body"}
    if unknown:
        raise ValidationFailed("templates may only define subject and body")
    data = body.model_dump(mode="json")
    data["team_ids"] = body.team_ids
    return data


async def _clear_other_defaults(db: AsyncSession, ctx: Ctx, keep: uuid.UUID | None) -> None:
    stmt = update(NotificationPolicy).where(NotificationPolicy.organization_id == ctx.org_id,
                                            NotificationPolicy.is_default.is_(True))
    if keep:
        stmt = stmt.where(NotificationPolicy.id != keep)
    await db.execute(stmt.values(is_default=False))


@router.get("/policies", response_model=list[PolicyOut])
async def list_policies(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    return (await db.scalars(select(NotificationPolicy).where(NotificationPolicy.organization_id == ctx.org_id)
                             .order_by(NotificationPolicy.priority, NotificationPolicy.name))).all()


@router.post("/policies", response_model=PolicyOut, status_code=201)
async def create_policy(body: PolicyIn, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    data = await _validate_policy(db, ctx, body)
    if body.is_default:
        await _clear_other_defaults(db, ctx, None)
    p = NotificationPolicy(organization_id=ctx.org_id, **data)
    db.add(p)
    await db.flush()
    audit.record(db, action="notification_policy.created", ctx=ctx, target_type="notification_policy", target_id=p.id,
                 details={"name": p.name})
    await db.commit()
    return p


@router.put("/policies/{policy_id}", response_model=PolicyOut)
async def update_policy(policy_id: uuid.UUID, body: PolicyIn, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    p = await db.scalar(select(NotificationPolicy).where(NotificationPolicy.id == policy_id,
                                                         NotificationPolicy.organization_id == ctx.org_id))
    if not p:
        raise NotFound("Notification policy")
    data = await _validate_policy(db, ctx, body)
    if body.is_default:
        await _clear_other_defaults(db, ctx, p.id)
    for k, v in data.items():
        setattr(p, k, v)
    audit.record(db, action="notification_policy.updated", ctx=ctx, target_type="notification_policy", target_id=p.id,
                 details={"name": p.name})
    await db.commit()
    return p


@router.delete("/policies/{policy_id}", response_model=Message)
async def delete_policy(policy_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                        db: AsyncSession = Depends(get_db)):
    p = await db.scalar(select(NotificationPolicy).where(NotificationPolicy.id == policy_id,
                                                         NotificationPolicy.organization_id == ctx.org_id))
    if not p:
        raise NotFound("Notification policy")
    await db.delete(p)
    audit.record(db, action="notification_policy.deleted", ctx=ctx, target_type="notification_policy",
                 target_id=policy_id, details={"name": p.name})
    await db.commit()
    return Message(message="Policy deleted")


# ---------------------------------------------------------------- delivery log & in-app

class DeliveryOut(ORM):
    id: uuid.UUID
    incident_id: uuid.UUID | None
    channel_id: uuid.UUID | None
    channel_type: str
    event: str
    step: int
    status: str
    status_reason: str
    attempts: int
    max_attempts: int
    next_attempt_at: datetime | None
    last_error: str
    subject: str
    sent_at: datetime | None
    created_at: datetime


@router.get("/deliveries", response_model=Page[DeliveryOut])
async def list_deliveries(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                          p: PageParams = Depends(), status: list[str] | None = Query(default=None),
                          channel_id: uuid.UUID | None = None, incident_id: uuid.UUID | None = None):
    stmt = select(NotificationDelivery).where(NotificationDelivery.organization_id == ctx.org_id)
    if status:
        stmt = stmt.where(NotificationDelivery.status.in_(status))
    if channel_id:
        stmt = stmt.where(NotificationDelivery.channel_id == channel_id)
    if incident_id:
        stmt = stmt.where(NotificationDelivery.incident_id == incident_id)
    total = await db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = (await db.scalars(stmt.order_by(NotificationDelivery.created_at.desc()).offset(p.offset)
                             .limit(p.page_size))).all()
    return Page(items=[DeliveryOut.model_validate(r) for r in rows], total=total or 0, page=p.page, page_size=p.page_size)


@router.post("/deliveries/{delivery_id}/retry", response_model=Message, status_code=202)
async def retry_delivery(delivery_id: uuid.UUID, ctx: Ctx = Depends(require(Permission.NOTIFICATIONS_MANAGE)),
                         db: AsyncSession = Depends(get_db)):
    d = await db.scalar(select(NotificationDelivery).where(NotificationDelivery.id == delivery_id,
                                                           NotificationDelivery.organization_id == ctx.org_id))
    if not d:
        raise NotFound("Delivery")
    if d.status not in (DeliveryStatus.FAILED,):
        raise ValidationFailed("only failed deliveries can be retried")
    d.status, d.next_attempt_at, d.max_attempts = DeliveryStatus.PENDING, datetime.now(UTC), d.attempts + 3
    await db.commit()
    from app.workers.dispatch import enqueue_delivery

    enqueue_delivery(d.id)
    return Message(message="Delivery re-queued")


class InAppOut(ORM):
    id: uuid.UUID
    incident_id: uuid.UUID | None
    title: str
    body: str
    severity: str
    read_at: datetime | None
    created_at: datetime


@router.get("/inbox")
async def inbox(ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db),
                unread: bool = False, limit: int = Query(50, ge=1, le=200)):
    if not ctx.user_id:
        return {"items": [], "unread": 0}
    stmt = select(InAppNotification).where(InAppNotification.organization_id == ctx.org_id,
                                           InAppNotification.user_id == ctx.user_id)
    if unread:
        stmt = stmt.where(InAppNotification.read_at.is_(None))
    rows = (await db.scalars(stmt.order_by(InAppNotification.created_at.desc()).limit(limit))).all()
    count = await db.scalar(select(func.count()).select_from(InAppNotification).where(
        InAppNotification.organization_id == ctx.org_id, InAppNotification.user_id == ctx.user_id,
        InAppNotification.read_at.is_(None)))
    return {"items": [InAppOut.model_validate(r) for r in rows], "unread": count or 0}


class ReadIn(BaseModel):
    ids: list[uuid.UUID] | None = None  # None = mark all as read


@router.post("/inbox/read", response_model=Message)
async def mark_read(body: ReadIn, ctx: Ctx = Depends(require(Permission.VIEW)), db: AsyncSession = Depends(get_db)):
    if not ctx.user_id:
        return Message(message="ok")
    stmt = update(InAppNotification).where(InAppNotification.organization_id == ctx.org_id,
                                           InAppNotification.user_id == ctx.user_id,
                                           InAppNotification.read_at.is_(None))
    if body.ids:
        stmt = stmt.where(InAppNotification.id.in_(body.ids))
    await db.execute(stmt.values(read_at=datetime.now(UTC)))
    await db.commit()
    return Message(message="Marked as read")
