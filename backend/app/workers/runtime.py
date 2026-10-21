"""Run async domain code from synchronous Celery tasks on a persistent per-process event loop.

asyncpg connections are bound to the loop that created them, so each worker process keeps one
loop for its whole lifetime instead of calling asyncio.run() per task.
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, TypeVar

T = TypeVar("T")
_loop: asyncio.AbstractEventLoop | None = None


def run(coro: Coroutine[Any, Any, T]) -> T:
    global _loop
    if _loop is None or _loop.is_closed():
        _loop = asyncio.new_event_loop()
        asyncio.set_event_loop(_loop)
    return _loop.run_until_complete(coro)


def shutdown_loop() -> None:
    global _loop
    if _loop is None or _loop.is_closed():
        return
    from app.core.db import dispose_engine
    from app.core.redis import close_redis

    try:
        _loop.run_until_complete(dispose_engine())
        _loop.run_until_complete(close_redis())
    finally:
        _loop.close()
        _loop = None
