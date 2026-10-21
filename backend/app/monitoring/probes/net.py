"""Network-level probes: TCP, TLS, SMTP, SSH, ICMP ping, DNS."""

from __future__ import annotations

import asyncio
import platform
import re
import ssl
from typing import Any

import dns.asyncresolver
import dns.exception
import dns.resolver

from app.models.enums import CheckOutcomeStatus
from app.monitoring import netguard
from app.monitoring.check_configs import DnsConfig, IcmpConfig, SmtpConfig, SshConfig, TcpConfig, TlsConfig
from app.monitoring.probes.base import ProbeContext, ProbeResult, Timer
from app.monitoring.probes.tlsinfo import describe_certificate, hostname_matches, insecure_context, verification_context


async def _guarded_addrs(host: str, ctx: ProbeContext, port: int | None = None) -> list[str] | ProbeResult:
    t = Timer()
    try:
        addrs = await netguard.authorize(host, ctx.scope, port)
    except netguard.TargetNotAllowed as exc:
        return ProbeResult.unknown(f"blocked by monitoring scope policy: {exc}", details={"error": "policy_blocked"})
    except netguard.ResolutionError as exc:
        return ProbeResult.down(str(exc), details={"error": "dns"}, dns_ms=t.ms())
    return [str(a) for a in addrs]


async def _open(ip: str, port: int, timeout: float, tls: ssl.SSLContext | None = None,
                server_hostname: str | None = None) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    return await asyncio.wait_for(
        asyncio.open_connection(ip, port, ssl=tls, server_hostname=server_hostname if tls else None,
                                limit=65536),
        timeout=timeout,
    )


async def _close(writer: asyncio.StreamWriter) -> None:
    try:
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), timeout=1)
    except Exception:
        pass


async def probe_tcp(cfg: TcpConfig, ctx: ProbeContext) -> ProbeResult:
    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    total = Timer()
    try:
        tls = verification_context() if cfg.use_tls else None
        reader, writer = await _open(addrs[0], cfg.port, ctx.timeout, tls, cfg.host)
    except TimeoutError:
        return ProbeResult.down(f"connection to {cfg.host}:{cfg.port} timed out")
    except (OSError, ssl.SSLError) as exc:
        return ProbeResult.down(f"connection to {cfg.host}:{cfg.port} failed: {exc}")
    connect_ms = total.ms()
    try:
        if cfg.send:
            writer.write(cfg.send.encode().decode("unicode_escape").encode("latin-1"))
            await writer.drain()
        if cfg.expect:
            data = await asyncio.wait_for(reader.read(4096), timeout=max(0.5, ctx.timeout - connect_ms / 1000))
            text = data.decode("utf-8", errors="replace")
            if cfg.expect not in text:
                return ProbeResult.down(f"expected {cfg.expect!r} not received", latency_ms=total.ms(),
                                        connect_ms=connect_ms, details={"received": text[:200]})
    except TimeoutError:
        return ProbeResult.down("timed out waiting for response", connect_ms=connect_ms)
    except OSError as exc:
        return ProbeResult.down(f"I/O error: {exc}", connect_ms=connect_ms)
    finally:
        await _close(writer)
    return ProbeResult(CheckOutcomeStatus.UP, f"port {cfg.port} open ({connect_ms:.0f} ms)", latency_ms=total.ms(),
                       connect_ms=connect_ms, details={"address": addrs[0]})


async def fetch_certificate(ip: str, port: int, server_name: str, timeout: float,
                            verify: bool = True) -> tuple[bytes | None, dict[str, Any]]:
    ctx = verification_context() if verify else insecure_context()
    reader, writer = await _open(ip, port, timeout, ctx, server_name)
    try:
        sslobj = writer.get_extra_info("ssl_object")
        der = sslobj.getpeercert(binary_form=True) if sslobj else None
        return der, {"tls_version": sslobj.version() if sslobj else None, "cipher": (sslobj.cipher() or [None])[0] if sslobj else None}
    finally:
        await _close(writer)


async def probe_tls(cfg: TlsConfig, ctx: ProbeContext) -> ProbeResult:
    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    sni = cfg.server_name or cfg.host
    t = Timer()
    verify_error = None
    try:
        der, meta = await fetch_certificate(addrs[0], cfg.port, sni, ctx.timeout, verify=True)
    except ssl.SSLCertVerificationError as exc:
        verify_error = exc.verify_message or str(exc)
        try:
            der, meta = await fetch_certificate(addrs[0], cfg.port, sni, ctx.timeout, verify=False)
        except Exception as exc2:  # noqa: BLE001
            return ProbeResult.down(f"TLS handshake failed: {exc2}")
    except TimeoutError:
        return ProbeResult.down(f"TLS connection to {cfg.host}:{cfg.port} timed out")
    except (OSError, ssl.SSLError) as exc:
        return ProbeResult.down(f"TLS connection failed: {exc}")
    elapsed = t.ms()
    info = describe_certificate(der)
    info.update(meta)
    info["hostname_match"] = hostname_matches(info, sni)
    info["verified"] = verify_error is None
    if verify_error:
        info["verify_error"] = verify_error
    res = ProbeResult(CheckOutcomeStatus.UP, f"certificate valid, {info.get('days_remaining')} days remaining",
                      latency_ms=elapsed, tls_ms=elapsed, details={"certificate": info})
    if info.get("expired"):
        res.status, res.message = CheckOutcomeStatus.DOWN, f"certificate expired on {info['not_after']}"
    elif verify_error and cfg.fail_on_invalid:
        res.status, res.message = CheckOutcomeStatus.DOWN, f"certificate verification failed: {verify_error}"
    return res


async def probe_smtp(cfg: SmtpConfig, ctx: ProbeContext) -> ProbeResult:
    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    t = Timer()
    try:
        reader, writer = await _open(addrs[0], cfg.port, ctx.timeout)
    except TimeoutError:
        return ProbeResult.down("SMTP connection timed out")
    except OSError as exc:
        return ProbeResult.down(f"SMTP connection failed: {exc}")
    connect_ms = t.ms()
    try:
        banner = await _smtp_reply(reader, ctx.timeout)
        if not banner.startswith("220"):
            return ProbeResult.down(f"unexpected SMTP banner: {banner[:200]}", connect_ms=connect_ms)
        writer.write(f"EHLO {cfg.ehlo_name}\r\n".encode())
        await writer.drain()
        ehlo = await _smtp_reply(reader, ctx.timeout)
        if not ehlo.startswith("250"):
            return ProbeResult.down(f"EHLO rejected: {ehlo[:200]}", connect_ms=connect_ms)
        details: dict[str, Any] = {"banner": banner[:200], "starttls_advertised": "STARTTLS" in ehlo.upper()}
        if cfg.starttls:
            if not details["starttls_advertised"]:
                return ProbeResult.down("STARTTLS not advertised", connect_ms=connect_ms, details=details)
            writer.write(b"STARTTLS\r\n")
            await writer.drain()
            reply = await _smtp_reply(reader, ctx.timeout)
            if not reply.startswith("220"):
                return ProbeResult.down(f"STARTTLS refused: {reply[:200]}", connect_ms=connect_ms, details=details)
            await writer.start_tls(verification_context(), server_hostname=cfg.host)
            sslobj = writer.get_extra_info("ssl_object")
            if sslobj:
                details["certificate"] = describe_certificate(sslobj.getpeercert(binary_form=True))
        else:
            writer.write(b"QUIT\r\n")
            await writer.drain()
    except TimeoutError:
        return ProbeResult.down("SMTP conversation timed out", connect_ms=connect_ms)
    except (OSError, ssl.SSLError) as exc:
        return ProbeResult.down(f"SMTP error: {exc}", connect_ms=connect_ms)
    finally:
        await _close(writer)
    return ProbeResult(CheckOutcomeStatus.UP, f"SMTP ready ({t.ms():.0f} ms)", latency_ms=t.ms(), connect_ms=connect_ms,
                       details=details)


async def _smtp_reply(reader: asyncio.StreamReader, timeout: float) -> str:
    lines = []
    while True:
        line = (await asyncio.wait_for(reader.readline(), timeout=timeout)).decode("utf-8", errors="replace")
        if not line:
            break
        lines.append(line.rstrip())
        if len(line) < 4 or line[3] != "-" or len(lines) > 50:
            break
    return "\n".join(lines)


async def probe_ssh(cfg: SshConfig, ctx: ProbeContext) -> ProbeResult:
    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    t = Timer()
    try:
        reader, writer = await _open(addrs[0], cfg.port, ctx.timeout)
    except TimeoutError:
        return ProbeResult.down("SSH connection timed out")
    except OSError as exc:
        return ProbeResult.down(f"SSH connection failed: {exc}")
    connect_ms = t.ms()
    try:
        banner = (await asyncio.wait_for(reader.readline(), timeout=ctx.timeout)).decode("utf-8", errors="replace").strip()
    except TimeoutError:
        return ProbeResult.down("no SSH banner received", connect_ms=connect_ms)
    finally:
        await _close(writer)
    if not banner.startswith(cfg.expect_banner):
        return ProbeResult.down(f"unexpected banner: {banner[:120]!r}", connect_ms=connect_ms)
    return ProbeResult(CheckOutcomeStatus.UP, banner[:120], latency_ms=t.ms(), connect_ms=connect_ms,
                       details={"banner": banner[:200]})


_PING_LOSS = re.compile(r"(\d+(?:\.\d+)?)% (?:packet )?loss")
_PING_RTT_LINUX = re.compile(r"= ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms")
_PING_RTT_WIN = re.compile(r"Minimum = (\d+)ms, Maximum = (\d+)ms, Average = (\d+)ms")


def parse_ping_output(out: str) -> dict[str, float | None]:
    loss_m = _PING_LOSS.search(out)
    loss = float(loss_m.group(1)) if loss_m else None
    m = _PING_RTT_LINUX.search(out)
    if m:
        return {"loss": loss, "min": float(m.group(1)), "avg": float(m.group(2)), "max": float(m.group(3)),
                "mdev": float(m.group(4))}
    m = _PING_RTT_WIN.search(out)
    if m:
        return {"loss": loss, "min": float(m.group(1)), "avg": float(m.group(3)), "max": float(m.group(2)), "mdev": None}
    return {"loss": loss if loss is not None else 100.0, "min": None, "avg": None, "max": None, "mdev": None}


async def probe_icmp(cfg: IcmpConfig, ctx: ProbeContext) -> ProbeResult:
    addrs = await _guarded_addrs(cfg.host, ctx)
    if isinstance(addrs, ProbeResult):
        return addrs
    ip = addrs[0]
    # Fixed argv (no shell); `ip` is a validated literal address.
    per_reply = max(1, int(min(ctx.timeout, 5)))
    if platform.system() == "Windows":
        argv = ["ping", "-n", str(cfg.count), "-w", str(per_reply * 1000), ip]
    else:
        argv = ["ping", "-n", "-q", "-c", str(cfg.count), "-W", str(per_reply), "-i", "0.2"]
        if ":" in ip:
            argv.insert(1, "-6")
        argv.append(ip)
    try:
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=ctx.timeout + cfg.count * per_reply + 2)
    except TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return ProbeResult.down("ping timed out")
    except FileNotFoundError:
        return ProbeResult.unknown("ping utility not available on worker")
    stats = parse_ping_output(out.decode("utf-8", errors="replace"))
    loss = stats["loss"] if stats["loss"] is not None else 100.0
    metrics = [("packet_loss_percent", "", float(loss))]
    if stats["avg"] is not None:
        metrics.append(("ping_rtt_ms", "", float(stats["avg"])))
    details = {"address": ip, **stats}
    if loss >= cfg.packet_loss_critical:
        return ProbeResult(CheckOutcomeStatus.DOWN, f"{loss:g}% packet loss", details=details, metrics=metrics)
    status = CheckOutcomeStatus.UP
    msg = f"{loss:g}% loss, avg {stats['avg']} ms"
    if loss >= cfg.packet_loss_warning or (cfg.latency_warning_ms and stats["avg"] and stats["avg"] > cfg.latency_warning_ms):
        status = CheckOutcomeStatus.DEGRADED
    return ProbeResult(status, msg, latency_ms=stats["avg"], details=details, metrics=metrics)


async def probe_dns(cfg: DnsConfig, ctx: ProbeContext) -> ProbeResult:
    resolver = dns.asyncresolver.Resolver(configure=cfg.nameserver is None)
    if cfg.nameserver:
        addrs = await _guarded_addrs(cfg.nameserver, ctx, 53)
        if isinstance(addrs, ProbeResult):
            return addrs
        resolver.nameservers = addrs[:1]
    resolver.lifetime = ctx.timeout
    resolver.timeout = ctx.timeout
    t = Timer()
    try:
        answer = await resolver.resolve(cfg.name, cfg.record_type, raise_on_no_answer=False)
    except dns.resolver.NXDOMAIN:
        return ProbeResult.down(f"NXDOMAIN: {cfg.name} does not exist", dns_ms=t.ms())
    except dns.resolver.NoNameservers as exc:
        return ProbeResult.down(f"no nameserver could answer: {exc}"[:300], dns_ms=t.ms())
    except dns.exception.Timeout:
        return ProbeResult.down("DNS query timed out", dns_ms=t.ms())
    except dns.exception.DNSException as exc:
        return ProbeResult.down(f"DNS error: {exc}"[:300], dns_ms=t.ms())
    elapsed = t.ms()
    values = sorted(r.to_text().strip('"').rstrip(".") for r in (answer.rrset or []))
    details = {"values": values[:50], "ttl": answer.rrset.ttl if answer.rrset else None}
    if not values:
        return ProbeResult.down(f"no {cfg.record_type} records for {cfg.name}", dns_ms=elapsed, latency_ms=elapsed,
                                details=details)
    if cfg.expected_values:
        expected = sorted(v.rstrip(".") for v in cfg.expected_values)
        ok = {
            "any": any(v in values for v in expected),
            "all": all(v in values for v in expected),
            "exact": values == expected,
        }[cfg.match]
        if not ok:
            return ProbeResult.down(f"unexpected answer {values[:5]} (expected {cfg.match} of {expected[:5]})",
                                    dns_ms=elapsed, latency_ms=elapsed, details=details)
    return ProbeResult(CheckOutcomeStatus.UP, f"{len(values)} {cfg.record_type} record(s) in {elapsed:.0f} ms",
                       latency_ms=elapsed, dns_ms=elapsed, details=details)
