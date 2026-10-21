from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Generic, TypeVar

from fastapi import Query
from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import ValidationFailed

T = TypeVar("T")


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class PageParams:
    def __init__(self, page: int = Query(1, ge=1, le=100000), page_size: int = Query(50, ge=1, le=500)):
        self.page = page
        self.page_size = page_size

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


class Message(BaseModel):
    message: str


class IdList(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


RANGES = {"15m": timedelta(minutes=15), "1h": timedelta(hours=1), "6h": timedelta(hours=6), "24h": timedelta(hours=24),
          "7d": timedelta(days=7), "30d": timedelta(days=30), "90d": timedelta(days=90)}


def resolve_range(range_: str | None, start: datetime | None, end: datetime | None,
                  default: str = "24h", max_days: int = 400) -> tuple[datetime, datetime]:
    now = datetime.now(UTC)
    if start or end:
        end = (end or now)
        start = start or end - RANGES[default]
        if start.tzinfo is None:
            start = start.replace(tzinfo=UTC)
        if end.tzinfo is None:
            end = end.replace(tzinfo=UTC)
    else:
        delta = RANGES.get(range_ or default)
        if delta is None:
            raise ValidationFailed(f"unknown range {range_!r}; use one of {', '.join(RANGES)}")
        end, start = now, now - delta
    if start >= end:
        raise ValidationFailed("start must be before end")
    if end - start > timedelta(days=max_days):
        raise ValidationFailed(f"range may not exceed {max_days} days")
    return start, end


def auto_step(start: datetime, end: datetime, points: int = 300) -> int:
    seconds = (end - start).total_seconds()
    for step in (10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400):
        if seconds / step <= points:
            return step
    return 86400
