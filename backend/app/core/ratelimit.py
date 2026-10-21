"""Fixed-window rate limiting backed by Redis with an in-process fallback."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

from fastapi import Request

from app.core.config import get_settings
from app.core.errors import RateLimited
from app.core.redis import get_redis

log = logging.getLogger("emonitor.ratelimit")
_local: dict[str, tuple[int, float]] = {}


def parse_limit(spec: str) -> tuple[int, int]:
    count, _, seconds = spec.partition("/")
    return int(count), int(seconds or 60)


async def hit(key: str, limit: int, window: int) -> tuple[bool, int]:
    """Register one hit. Returns (allowed, retry_after_seconds)."""
    now = time.time()
    bucket = int(now // window)
    rkey = f"emonitor:rl:{key}:{bucket}"
    retry_after = int(window - (now % window)) + 1
    try:
        r = get_redis()
        async with r.pipeline(transaction=True) as p:
            p.incr(rkey)
            p.expire(rkey, window + 1)
            count, _ = await p.execute()
    except Exception:  # Redis unavailable — degrade to per-process limiting rather than failing open
        log.warning("rate limiter falling back to local memory", exc_info=False)
        count, exp = _local.get(rkey, (0, now + window))
        count += 1
        _local[rkey] = (count, exp)
        if len(_local) > 50_000:
            for k, (_, e) in list(_local.items()):
                if e < now:
                    _local.pop(k, None)
    return int(count) <= limit, retry_after


def client_ip(request: Request) -> str:
    """Client IP honouring X-Forwarded-For only from trusted proxies (nginx)."""
    peer = request.client.host if request.client else "unknown"
    if peer in get_settings().trusted_proxies:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[-1].strip() or peer
        real = request.headers.get("x-real-ip")
        if real:
            return real.strip()
    return peer


def limiter(scope: str, setting_name: str, key_func: Callable[[Request], str] | None = None):
    """FastAPI dependency factory: `Depends(limiter("login", "rate_limit_login"))`."""

    async def _dep(request: Request) -> None:
        limit, window = parse_limit(getattr(get_settings(), setting_name))
        key = f"{scope}:{key_func(request) if key_func else client_ip(request)}"
        allowed, retry = await hit(key, limit, window)
        if not allowed:
            raise RateLimited(retry)

    return _dep
