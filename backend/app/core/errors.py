"""Structured API errors: every error response is {"error": {code, message, details, request_id}}."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("emonitor.errors")


class ApiError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, details: Any = None, status_code: int | None = None, code: str | None = None,
                 headers: dict[str, str] | None = None):
        super().__init__(message)
        self.message = message
        self.details = details
        self.headers = headers
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code


class NotFound(ApiError):
    status_code = 404
    code = "not_found"

    def __init__(self, what: str = "Resource"):
        super().__init__(f"{what} not found")


class Forbidden(ApiError):
    status_code = 403
    code = "forbidden"

    def __init__(self, message: str = "You do not have permission to perform this action"):
        super().__init__(message)


class Unauthorized(ApiError):
    status_code = 401
    code = "unauthorized"

    def __init__(self, message: str = "Authentication required"):
        super().__init__(message, headers={"WWW-Authenticate": "Bearer"})


class Conflict(ApiError):
    status_code = 409
    code = "conflict"


class ValidationFailed(ApiError):
    status_code = 422
    code = "validation_error"


class RateLimited(ApiError):
    status_code = 429
    code = "rate_limited"

    def __init__(self, retry_after: int):
        super().__init__("Too many requests", headers={"Retry-After": str(retry_after)})


class ServiceUnavailable(ApiError):
    status_code = 503
    code = "unavailable"

    def __init__(self, message: str, retry_after: int = 5):
        super().__init__(message, headers={"Retry-After": str(retry_after)})


def _body(request: Request, code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": getattr(request.state, "request_id", None),
        }
    }


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(_body(request, exc.code, exc.message, exc.details), status_code=exc.status_code,
                            headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {"loc": list(e.get("loc", [])), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()
        ]
        return JSONResponse(_body(request, "validation_error", "Request validation failed", details), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed", 401: "unauthorized", 403: "forbidden"}.get(
            exc.status_code, "http_error"
        )
        return JSONResponse(_body(request, code, str(exc.detail)), status_code=exc.status_code,
                            headers=getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", extra={"path": request.url.path})
        return JSONResponse(_body(request, "internal_error", "Internal server error"), status_code=500)
