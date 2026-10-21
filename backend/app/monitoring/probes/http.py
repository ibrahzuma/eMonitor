"""HTTP/HTTPS website and API probe."""

from __future__ import annotations

import base64
import json
import re
import socket
from typing import Any
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver

from app.core.config import get_settings
from app.models.enums import CheckOutcomeStatus
from app.monitoring import netguard
from app.monitoring.check_configs import HttpConfig, HttpSecrets, JsonAssertion, status_matches
from app.monitoring.probes.base import ProbeContext, ProbeResult, Timer
from app.monitoring.probes.tlsinfo import describe_certificate, insecure_context, verification_context


class GuardedResolver(AbstractResolver):
    """Resolver that only returns addresses authorized by the organization's scope."""

    def __init__(self, scope: netguard.Scope, ip_version: str, state: dict[str, Any]):
        self.scope = scope
        self.ip_version = ip_version
        self.state = state

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list[dict[str, Any]]:
        t = Timer()
        try:
            addrs = await netguard.authorize(host, self.scope, port)
        except netguard.TargetNotAllowed as exc:
            self.state["blocked"] = str(exc)
            raise OSError(str(exc)) from exc
        except netguard.ResolutionError as exc:
            self.state["dns_error"] = str(exc)
            raise OSError(str(exc)) from exc
        finally:
            self.state["dns_ms"] = self.state.get("dns_ms", 0.0) + t.ms()
        if self.ip_version == "4":
            addrs = [a for a in addrs if a.version == 4]
        elif self.ip_version == "6":
            addrs = [a for a in addrs if a.version == 6]
        if not addrs:
            self.state["dns_error"] = f"no IPv{self.ip_version} address for {host}"
            raise OSError(self.state["dns_error"])
        self.state.setdefault("resolved", []).extend(str(a) for a in addrs)
        return [
            {
                "hostname": host,
                "host": str(a),
                "port": port,
                "family": socket.AF_INET6 if a.version == 6 else socket.AF_INET,
                "proto": 0,
                "flags": socket.AI_NUMERICHOST,
            }
            for a in addrs
        ]

    async def close(self) -> None:
        return None


async def _read_capped(resp: aiohttp.ClientResponse, limit: int) -> tuple[bytes, bool]:
    chunks: list[bytes] = []
    size = 0
    while size < limit:
        chunk = await resp.content.read(min(65536, limit - size))
        if not chunk:
            return b"".join(chunks), False
        chunks.append(chunk)
        size += len(chunk)
    truncated = not resp.content.at_eof()
    return b"".join(chunks), truncated


def _json_get(doc: Any, path: str) -> tuple[bool, Any]:
    cur = doc
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return False, None
    return True, cur


def evaluate_json(doc: Any, assertion: JsonAssertion) -> str | None:
    """Return a failure message or None."""
    found, value = _json_get(doc, assertion.path)
    op = assertion.op
    if op == "exists":
        return None if found else f"JSON path {assertion.path} not found"
    if not found:
        return f"JSON path {assertion.path} not found"
    try:
        if op == "eq" and value != assertion.value and str(value) != str(assertion.value):
            return f"{assertion.path} = {value!r}, expected {assertion.value!r}"
        if op == "ne" and (value == assertion.value or str(value) == str(assertion.value)):
            return f"{assertion.path} must not equal {assertion.value!r}"
        if op == "contains" and str(assertion.value) not in (json.dumps(value) if not isinstance(value, str) else value):
            return f"{assertion.path} does not contain {assertion.value!r}"
        if op == "gt" and not float(value) > float(assertion.value):
            return f"{assertion.path} = {value} is not > {assertion.value}"
        if op == "lt" and not float(value) < float(assertion.value):
            return f"{assertion.path} = {value} is not < {assertion.value}"
    except (TypeError, ValueError):
        return f"{assertion.path} = {value!r} cannot be compared with {assertion.value!r}"
    return None


def _auth_headers(secrets: HttpSecrets | None) -> dict[str, str]:
    if not secrets:
        return {}
    headers = dict(secrets.headers)
    if secrets.bearer_token:
        headers["Authorization"] = f"Bearer {secrets.bearer_token}"
    elif secrets.basic_username is not None:
        raw = f"{secrets.basic_username}:{secrets.basic_password or ''}".encode()
        headers["Authorization"] = "Basic " + base64.b64encode(raw).decode()
    return headers


def evaluate_response(cfg: HttpConfig, status: int, headers: dict[str, str], body: bytes,
                      truncated: bool) -> list[str]:
    failures: list[str] = []
    if not status_matches(status, cfg.expected_status):
        failures.append(f"HTTP {status} not in expected {', '.join(cfg.expected_status)}")
    if cfg.keyword:
        text = body.decode("utf-8", errors="replace")
        hay, needle = (text, cfg.keyword) if cfg.keyword_case_sensitive else (text.lower(), cfg.keyword.lower())
        present = needle in hay
        if cfg.keyword_absent and present:
            failures.append(f"forbidden keyword {cfg.keyword!r} found in response")
        elif not cfg.keyword_absent and not present:
            failures.append(f"keyword {cfg.keyword!r} not found in response" + (" (body truncated)" if truncated else ""))
    lower_headers = {k.lower(): v for k, v in headers.items()}
    for name, pattern in cfg.expected_headers.items():
        val = lower_headers.get(name.lower())
        if val is None:
            failures.append(f"missing response header {name}")
        elif not re.search(pattern, val):
            failures.append(f"header {name}={val!r} does not match {pattern!r}")
    if cfg.json_assertions:
        try:
            doc = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            failures.append("response is not valid JSON")
        else:
            for a in cfg.json_assertions:
                msg = evaluate_json(doc, a)
                if msg:
                    failures.append(msg)
    return failures


async def probe_http(cfg: HttpConfig, ctx: ProbeContext) -> ProbeResult:
    s = get_settings()
    state: dict[str, Any] = {}
    timings: dict[str, float] = {}

    trace = aiohttp.TraceConfig()

    async def _conn_start(session: Any, tctx: Any, params: Any) -> None:
        tctx.conn_t = Timer()

    async def _conn_end(session: Any, tctx: Any, params: Any) -> None:
        timings["connect_ms"] = timings.get("connect_ms", 0.0) + tctx.conn_t.ms()

    trace.on_connection_create_start.append(_conn_start)
    trace.on_connection_create_end.append(_conn_end)

    ssl_ctx = verification_context() if cfg.verify_tls else insecure_context()
    connector = aiohttp.TCPConnector(
        resolver=GuardedResolver(ctx.scope, cfg.ip_version, state),
        ssl=ssl_ctx,
        force_close=True,
        limit=1,
        use_dns_cache=False,
    )
    headers = {"User-Agent": s.probe_user_agent, **cfg.headers, **_auth_headers(ctx.secrets)}
    timeout = aiohttp.ClientTimeout(total=ctx.timeout, sock_connect=min(ctx.timeout, 10))
    url = cfg.url
    method = cfg.method
    chain: list[dict[str, Any]] = []
    cert: dict[str, Any] = {}
    total = Timer()
    try:
        async with aiohttp.ClientSession(
            connector=connector, trace_configs=[trace], timeout=timeout, auto_decompress=True, cookie_jar=aiohttp.DummyCookieJar()
        ) as session:
            for hop in range(cfg.max_redirects + 1):
                # aiohttp bypasses the resolver for IP-literal hosts, so authorize those explicitly
                # (applies to the initial URL and to every redirect hop).
                hop_host = urlsplit(url).hostname or ""
                if netguard.parse_ip(hop_host):
                    try:
                        netguard.check_ip(netguard.parse_ip(hop_host), ctx.scope)  # type: ignore[arg-type]
                    except netguard.TargetNotAllowed as exc:
                        return ProbeResult.unknown(f"blocked by monitoring scope policy: {exc}",
                                                   details={"error": "policy_blocked", "redirects": chain})
                async with session.request(
                    method, url, headers=headers, data=cfg.body if method not in ("GET", "HEAD") else None,
                    allow_redirects=False, max_line_size=16384, max_field_size=16384,
                ) as resp:
                    ttfb = total.ms()
                    if urlsplit(url).scheme == "https" and resp.connection and resp.connection.transport:
                        sslobj = resp.connection.transport.get_extra_info("ssl_object")
                        if sslobj is not None and not cert:
                            cert = describe_certificate(sslobj.getpeercert(binary_form=True))
                            cert["tls_version"] = sslobj.version()
                    location = resp.headers.get("Location")
                    if cfg.follow_redirects and resp.status in (301, 302, 303, 307, 308) and location:
                        chain.append({"url": url, "status": resp.status})
                        if hop == cfg.max_redirects:
                            return ProbeResult.down(f"too many redirects (>{cfg.max_redirects})",
                                                    details={"redirects": chain}, http_status=resp.status)
                        nxt = urljoin(url, location)
                        if urlsplit(nxt).scheme not in ("http", "https"):
                            return ProbeResult.down(f"redirect to unsupported scheme: {nxt[:200]}", details={"redirects": chain})
                        url = nxt
                        if resp.status in (301, 302, 303) and method not in ("GET", "HEAD"):
                            method = "GET"
                        continue
                    body, truncated = (b"", False) if method == "HEAD" else await _read_capped(resp, s.http_max_body_bytes)
                    elapsed = total.ms()
                    resp_headers = {k: v for k, v in resp.headers.items()}
                    status_code = resp.status
                    break
    except TimeoutError:
        return ProbeResult.down(f"request timed out after {ctx.timeout:g}s", details={"redirects": chain, "error": "timeout"},
                                dns_ms=state.get("dns_ms"), connect_ms=timings.get("connect_ms"))
    except aiohttp.ClientConnectorCertificateError as exc:
        details: dict[str, Any] = {"error": "tls_verification", "redirects": chain}
        cert_info = await _fallback_certificate(url, ctx)
        if cert_info:
            details["certificate"] = cert_info
        return ProbeResult.down(f"TLS certificate verification failed: {exc.certificate_error}", details=details,
                                dns_ms=state.get("dns_ms"))
    except (aiohttp.ClientError, OSError) as exc:
        if state.get("blocked"):
            return ProbeResult.unknown(f"blocked by monitoring scope policy: {state['blocked']}",
                                       details={"error": "policy_blocked"})
        if state.get("dns_error"):
            return ProbeResult.down(state["dns_error"], details={"error": "dns", "redirects": chain}, dns_ms=state.get("dns_ms"))
        return ProbeResult.down(f"connection failed: {_short(exc)}", details={"error": "connect", "redirects": chain},
                                dns_ms=state.get("dns_ms"))

    failures = evaluate_response(cfg, status_code, resp_headers, body, truncated)
    details = {
        "final_url": url,
        "redirects": chain,
        "resolved": state.get("resolved", [])[:8],
        "body_bytes": len(body),
        "body_truncated": truncated,
        "headers": {k: v for k, v in list(resp_headers.items())[:40]},
    }
    if cert:
        details["certificate"] = cert
    result = ProbeResult(
        CheckOutcomeStatus.UP,
        f"HTTP {status_code} in {elapsed:.0f} ms",
        latency_ms=elapsed,
        dns_ms=state.get("dns_ms"),
        connect_ms=timings.get("connect_ms"),
        ttfb_ms=ttfb,
        http_status=status_code,
        details=details,
    )
    if failures:
        result.status = CheckOutcomeStatus.DOWN
        result.message = "; ".join(failures)[:900]
        details["failures"] = failures
    elif cfg.degraded_threshold_ms and elapsed > cfg.degraded_threshold_ms:
        result.status = CheckOutcomeStatus.DEGRADED
        result.message = f"slow response: {elapsed:.0f} ms > {cfg.degraded_threshold_ms:.0f} ms"
    if cert.get("expired"):
        result.status = CheckOutcomeStatus.DOWN
        result.message = f"TLS certificate expired on {cert['not_after']}"
    return result


async def _fallback_certificate(url: str, ctx: ProbeContext) -> dict[str, Any]:
    """Fetch the certificate without verification so users can see why verification failed."""
    from app.monitoring.probes.net import fetch_certificate

    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return {}
    try:
        addrs = await netguard.authorize(parts.hostname, ctx.scope, parts.port or 443)
        der, _ = await fetch_certificate(str(addrs[0]), parts.port or 443, parts.hostname, min(ctx.timeout, 5), verify=False)
        return describe_certificate(der)
    except Exception:
        return {}


def _short(exc: BaseException) -> str:
    text = str(exc) or exc.__class__.__name__
    return text[:300]
