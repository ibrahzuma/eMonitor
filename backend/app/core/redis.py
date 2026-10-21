"""Shared async Redis client (overridable in tests)."""

from __future__ import annotations

import redis.asyncio as aioredis

from app.core.config import get_settings

_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        _client = aioredis.from_url(get_settings().redis_url, decode_responses=True, health_check_interval=30,
                                    socket_connect_timeout=2, socket_timeout=5, retry_on_timeout=False)
    return _client


def set_redis(client: aioredis.Redis | None) -> None:
    global _client
    _client = client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None
