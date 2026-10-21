"""FastAPI application factory."""

from __future__ import annotations

import logging
import re
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import get_settings
from app.core.db import dispose_engine
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging, request_id_var
from app.core.ratelimit import client_ip, hit, parse_limit
from app.core.redis import close_redis

log = logging.getLogger("emonitor.api")
_RID = re.compile(r"^[A-Za-z0-9._\-]{1,64}$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    s.validate_for_production()
    if s.dev_inline_workers:
        from app.workers import devinline

        devinline.start()
    yield
    if s.dev_inline_workers:
        from app.workers import devinline

        await devinline.stop()
    await dispose_engine()
    await close_redis()


def build_router() -> APIRouter:
    from app.api.v1 import (
        agents,
        alerts,
        auth,
        dashboard,
        incidents,
        maintenance,
        notifications,
        orgs,
        reports,
        resources,
        system,
        telemetry,
    )

    api = APIRouter()
    for mod in (auth, orgs, resources, agents, telemetry, incidents, alerts, notifications, maintenance, reports,
                dashboard, system):
        api.include_router(mod.router)
    return api


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    app = FastAPI(
        title="eMonitor API",
        version="1.0.0",
        description="Server, website and infrastructure monitoring platform. All endpoints are versioned under /api/v1.",
        openapi_url=f"{s.api_prefix}/openapi.json",
        docs_url=f"{s.api_prefix}/docs",
        redoc_url=f"{s.api_prefix}/redoc",
        lifespan=lifespan,
    )
    install_error_handlers(app)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Organization-ID", "X-CSRF-Token", "X-Request-ID", "X-API-Key"],
        expose_headers=["X-Request-ID", "Retry-After"],
        max_age=600,
    )

    general_limit, general_window = parse_limit(s.rate_limit_api)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id", "")
        if not _RID.match(rid):
            rid = uuid.uuid4().hex
        request.state.request_id = rid
        token = request_id_var.set(rid)
        started = time.perf_counter()
        try:
            path = request.url.path
            if path.startswith(s.api_prefix) and not path.startswith(f"{s.api_prefix}/health") and \
                    not path.startswith(f"{s.api_prefix}/agents/") and request.method != "OPTIONS":
                allowed, retry = await hit(f"api:{client_ip(request)}", general_limit, general_window)
                if not allowed:
                    resp = JSONResponse({"error": {"code": "rate_limited", "message": "Too many requests",
                                                   "details": None, "request_id": rid}}, status_code=429,
                                        headers={"Retry-After": str(retry)})
                    resp.headers["X-Request-ID"] = rid
                    return resp
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        elapsed = (time.perf_counter() - started) * 1000
        if elapsed > 2000:
            log.warning("slow request", extra={"path": request.url.path, "ms": round(elapsed), "status": response.status_code})
        return response

    app.include_router(build_router(), prefix=s.api_prefix)
    return app


app = create_app()
