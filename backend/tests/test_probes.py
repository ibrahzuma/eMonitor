"""Probe behaviour against local test servers (scope authorizes 127.0.0.0/8)."""

from __future__ import annotations

import asyncio
import ipaddress
import ssl
from datetime import UTC, datetime, timedelta

import pytest
from aiohttp import web

from app.models.enums import CheckOutcomeStatus
from app.monitoring.netguard import Scope
from app.monitoring.probes import ProbeContext, run_probe
from app.monitoring.probes.net import parse_ping_output
from app.monitoring.probes.snmp import counter_rate
from app.monitoring.probes.tlsinfo import describe_certificate, hostname_matches

LOCAL = Scope(allow_public=False, cidrs=(ipaddress.ip_network("127.0.0.0/8"),))


def ctx(timeout: float = 3.0, secrets=None) -> ProbeContext:
    return ProbeContext(scope=LOCAL, timeout=timeout, secrets=secrets)


@pytest.fixture
async def http_server():
    state = {"status": 200, "body": "hello Example Domain", "delay": 0.0}

    async def root(request):
        await asyncio.sleep(state["delay"])
        return web.Response(status=state["status"], text=state["body"], headers={"X-App": "emon-1.2"})

    async def js(request):
        return web.json_response({"status": "ok", "items": [{"id": 7}], "count": 3})

    async def redirect(request):
        raise web.HTTPFound("/")

    async def loop(request):
        raise web.HTTPFound("/loop")

    async def auth(request):
        if request.headers.get("Authorization") != "Bearer s3cret":
            return web.Response(status=401)
        return web.Response(text="ok")

    app = web.Application()
    app.router.add_get("/", root)
    app.router.add_post("/", root)
    app.router.add_get("/json", js)
    app.router.add_get("/redirect", redirect)
    app.router.add_get("/loop", loop)
    app.router.add_get("/auth", auth)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}", state, port
    await runner.cleanup()


async def test_http_up_with_keyword_and_headers(http_server):
    base, _, _ = http_server
    r = await run_probe("http", {"url": base + "/", "keyword": "example domain",
                                 "expected_headers": {"X-App": r"^emon-\d"}}, ctx())
    assert r.status == CheckOutcomeStatus.UP, r.message
    assert r.http_status == 200 and r.latency_ms is not None and r.ttfb_ms is not None


async def test_http_status_and_keyword_failures(http_server):
    base, state, _ = http_server
    state["status"] = 503
    r = await run_probe("http", {"url": base + "/"}, ctx())
    assert r.status == CheckOutcomeStatus.DOWN and "503" in r.message
    state["status"] = 200
    r = await run_probe("http", {"url": base + "/", "keyword": "missing words"}, ctx())
    assert r.status == CheckOutcomeStatus.DOWN and "keyword" in r.message
    r = await run_probe("http", {"url": base + "/", "keyword": "hello", "keyword_absent": True}, ctx())
    assert r.status == CheckOutcomeStatus.DOWN


async def test_http_json_assertions(http_server):
    base, _, _ = http_server
    good = await run_probe("http", {"url": base + "/json", "json_assertions": [
        {"path": "status", "op": "eq", "value": "ok"}, {"path": "items.0.id", "op": "eq", "value": 7},
        {"path": "count", "op": "gt", "value": 2}]}, ctx())
    assert good.status == CheckOutcomeStatus.UP, good.message
    bad = await run_probe("http", {"url": base + "/json", "json_assertions": [{"path": "status", "value": "down"}]}, ctx())
    assert bad.status == CheckOutcomeStatus.DOWN


async def test_http_redirects_and_loop(http_server):
    base, _, _ = http_server
    r = await run_probe("http", {"url": base + "/redirect"}, ctx())
    assert r.status == CheckOutcomeStatus.UP and r.details["redirects"][0]["status"] == 302
    r = await run_probe("http", {"url": base + "/loop", "max_redirects": 3}, ctx())
    assert r.status == CheckOutcomeStatus.DOWN and "redirect" in r.message


async def test_http_timeout_and_degraded(http_server):
    base, state, _ = http_server
    state["delay"] = 0.3
    slow = await run_probe("http", {"url": base + "/", "degraded_threshold_ms": 100}, ctx())
    assert slow.status == CheckOutcomeStatus.DEGRADED
    state["delay"] = 2.0
    t = await run_probe("http", {"url": base + "/"}, ctx(timeout=0.5))
    assert t.status == CheckOutcomeStatus.DOWN and "timed out" in t.message


async def test_http_secret_auth_header(http_server):
    from app.monitoring.check_configs import HttpSecrets

    base, _, _ = http_server
    assert (await run_probe("http", {"url": base + "/auth"}, ctx())).status == CheckOutcomeStatus.DOWN
    r = await run_probe("http", {"url": base + "/auth"}, ctx(secrets=HttpSecrets(bearer_token="s3cret")))
    assert r.status == CheckOutcomeStatus.UP


async def test_http_blocked_target_is_unknown_not_down():
    r = await run_probe("http", {"url": "http://127.0.0.1:9/"}, ProbeContext(scope=Scope(allow_public=True), timeout=2))
    assert r.status == CheckOutcomeStatus.UNKNOWN and "scope" in r.message


async def test_http_connection_refused_is_down():
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    r = await run_probe("http", {"url": f"http://127.0.0.1:{port}/"}, ctx(timeout=2))
    assert r.status == CheckOutcomeStatus.DOWN


async def test_tcp_probe(http_server):
    _, _, port = http_server
    assert (await run_probe("tcp", {"host": "127.0.0.1", "port": port}, ctx())).status == CheckOutcomeStatus.UP
    r = await run_probe("tcp", {"host": "127.0.0.1", "port": port, "send": "GET / HTTP/1.0\\r\\n\\r\\n",
                                "expect": "HTTP/1."}, ctx())
    assert r.status == CheckOutcomeStatus.UP, r.message


async def test_ssh_and_smtp_banner_probes():
    async def ssh_handler(reader, writer):
        writer.write(b"SSH-2.0-OpenSSH_9.6\r\n")
        await writer.drain()
        writer.close()

    async def smtp_handler(reader, writer):
        writer.write(b"220 mail.test ESMTP\r\n")
        await writer.drain()
        await reader.readline()
        writer.write(b"250-mail.test\r\n250 STARTTLS\r\n")
        await writer.drain()
        await reader.readline()
        writer.close()

    ssh = await asyncio.start_server(ssh_handler, "127.0.0.1", 0)
    smtp = await asyncio.start_server(smtp_handler, "127.0.0.1", 0)
    try:
        r = await run_probe("ssh", {"host": "127.0.0.1", "port": ssh.sockets[0].getsockname()[1]}, ctx())
        assert r.status == CheckOutcomeStatus.UP and "OpenSSH" in r.message
        r = await run_probe("smtp", {"host": "127.0.0.1", "port": smtp.sockets[0].getsockname()[1]}, ctx())
        assert r.status == CheckOutcomeStatus.UP and r.details["starttls_advertised"] is True
    finally:
        ssh.close()
        smtp.close()


async def test_tls_probe_reports_certificate_expiry(tmp_path):
    trustme = pytest.importorskip("trustme")
    ca = trustme.CA()
    cert = ca.issue_cert("localhost", "127.0.0.1",
                         not_after=datetime.now(UTC) + timedelta(days=10))
    server_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    cert.configure_cert(server_ctx)

    async def handler(reader, writer):
        try:
            await reader.read(1)
        except Exception:
            pass
        writer.close()

    srv = await asyncio.start_server(handler, "127.0.0.1", 0, ssl=server_ctx)
    port = srv.sockets[0].getsockname()[1]
    try:
        # Not trusted by the system store → verification fails but the certificate is still described
        r = await run_probe("tls", {"host": "127.0.0.1", "port": port, "server_name": "localhost"}, ctx())
        assert r.status == CheckOutcomeStatus.DOWN
        c = r.details["certificate"]
        assert c["verified"] is False and 9 <= c["days_remaining"] <= 10 and c["hostname_match"]
        r = await run_probe("tls", {"host": "127.0.0.1", "port": port, "server_name": "localhost",
                                    "fail_on_invalid": False}, ctx())
        assert r.status == CheckOutcomeStatus.UP
    finally:
        srv.close()


def test_certificate_helpers():
    trustme = pytest.importorskip("trustme")
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import Encoding

    ca = trustme.CA()
    pem = ca.issue_cert("*.example.com", not_after=datetime.now(UTC) - timedelta(days=2)).cert_chain_pems[0].bytes()
    der = x509.load_pem_x509_certificate(pem).public_bytes(Encoding.DER)
    info = describe_certificate(der)
    assert info["expired"] is True and info["days_remaining"] < 0
    assert hostname_matches(info, "api.example.com") and not hostname_matches(info, "a.b.example.com")


def test_ping_output_parsing():
    linux = ("4 packets transmitted, 3 received, 25% packet loss, time 3004ms\n"
             "rtt min/avg/max/mdev = 10.1/12.5/15.0/1.2 ms")
    p = parse_ping_output(linux)
    assert p["loss"] == 25.0 and p["avg"] == 12.5
    win = "Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),\n Minimum = 1ms, Maximum = 3ms, Average = 2ms"
    assert parse_ping_output(win)["avg"] == 2.0
    assert parse_ping_output("100% packet loss")["avg"] is None


def test_snmp_counter_rate():
    assert counter_rate(None, 100, 10) is None
    assert counter_rate(1000, 2000, 10) == 100
    assert counter_rate(5000, 100, 10) is None  # reset
    near = 2**64 - 100
    assert counter_rate(near, 100, 10) == 20


async def test_invalid_config_is_unknown():
    r = await run_probe("http", {"url": "not a url"}, ctx())
    assert r.status == CheckOutcomeStatus.UNKNOWN


def test_db_query_must_be_read_only():
    from pydantic import ValidationError

    from app.monitoring.check_configs import PostgresConfig

    PostgresConfig(host="db", query="SELECT count(*) FROM jobs WHERE failed")
    for q in ("DELETE FROM x", "SELECT 1; DROP TABLE x", "select pg_sleep(10)", "UPDATE t SET a=1",
              "WITH x AS (DELETE FROM t RETURNING *) SELECT 1"):
        with pytest.raises(ValidationError):
            PostgresConfig(host="db", query=q)
