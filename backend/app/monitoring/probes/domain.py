"""Domain registration expiry probe (RDAP first, WHOIS fallback).

RDAP servers come from the IANA bootstrap registry (cached for 24 h). When a registry has no working
RDAP service (common for ccTLDs), the WHOIS server is discovered via whois.iana.org and the response
is parsed for an expiry date. Lookups go only to registry servers published by IANA — never to a
user-supplied host — and a failed lookup is reported as UNKNOWN, not as downtime.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import UTC, datetime
from typing import Any

import aiohttp

from app.core.config import get_settings
from app.models.enums import CheckOutcomeStatus
from app.monitoring.check_configs import DomainConfig
from app.monitoring.probes.base import ProbeContext, ProbeResult, Timer

IANA_RDAP_BOOTSTRAP = "https://data.iana.org/rdap/dns.json"
IANA_WHOIS = "whois.iana.org"
_bootstrap: tuple[float, dict[str, str]] | None = None
_whois_servers: dict[str, str] = {}

# Second-level labels under which registrations happen for many ccTLDs (e.g. qalaam.co.tz, bbc.co.uk).
_SLD = {"co", "com", "net", "org", "ac", "go", "gov", "edu", "or", "ne", "mil", "sch", "nic", "info", "biz",
        "ltd", "plc", "me", "web", "gen", "firm", "nom", "int", "mobi", "tv", "sc", "us"}

_EXPIRY_KEYS = re.compile(
    r"^\s*(?:registry expiry date|registrar registration expiration date|expiration date|expiry date|"
    r"expires(?: on)?|expire|exp date|paid-till|renewal date|valid until|domain expiration date)\s*[:\]]\s*(.+)$",
    re.IGNORECASE | re.MULTILINE)
_REGISTRAR = re.compile(r"^\s*(?:registrar|sponsoring registrar|registrar name)\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_NSERVER = re.compile(r"^\s*(?:name server|nserver|nameserver)s?\s*:\s*(\S+)", re.IGNORECASE | re.MULTILINE)
_DATE_FORMATS = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d.%m.%Y",
                 "%d.%m.%Y %H:%M:%S", "%Y.%m.%d", "%d-%b-%Y", "%d/%m/%Y", "%Y/%m/%d", "%d %b %Y", "%b %d %Y")


def registrable_domain(host: str) -> str:
    """Best-effort registrable domain: www.qalaam.co.tz → qalaam.co.tz, api.github.com → github.com."""
    labels = [x for x in host.lower().strip().rstrip(".").split(".") if x]
    if len(labels) <= 2:
        return ".".join(labels)
    if len(labels[-1]) == 2 and labels[-2] in _SLD:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def parse_date(raw: str) -> datetime | None:
    value = raw.strip().split(" (")[0].strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    try:
        from dateutil import parser

        dt = parser.parse(value, dayfirst=bool(re.match(r"^\d{1,2}[./]\d{1,2}[./]\d{4}", value)))
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except (ValueError, OverflowError):
        return None


def parse_whois(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    m = _EXPIRY_KEYS.search(text)
    if m:
        dt = parse_date(m.group(1))
        if dt:
            out["expires_at"] = dt
    r = _REGISTRAR.search(text)
    if r:
        out["registrar"] = r.group(1).strip()[:200]
    ns = [x.lower().rstrip(".") for x in _NSERVER.findall(text)]
    if ns:
        out["nameservers"] = sorted(set(ns))[:13]
    return out


def parse_rdap(doc: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for ev in doc.get("events") or []:
        if ev.get("eventAction") == "expiration" and ev.get("eventDate"):
            dt = parse_date(ev["eventDate"].replace("+00:00", "Z"))
            if dt:
                out["expires_at"] = dt
    for ent in doc.get("entities") or []:
        if "registrar" in (ent.get("roles") or []):
            for item in (ent.get("vcardArray") or [None, []])[1] or []:
                if isinstance(item, list) and item and item[0] == "fn":
                    out["registrar"] = str(item[3])[:200]
    ns = [str(n.get("ldhName", "")).lower().rstrip(".") for n in doc.get("nameservers") or [] if n.get("ldhName")]
    if ns:
        out["nameservers"] = sorted(set(ns))[:13]
    if doc.get("status"):
        out["status"] = [str(s) for s in doc["status"]][:10]
    return out


async def _rdap_base(session: aiohttp.ClientSession, tld: str) -> str | None:
    global _bootstrap
    if _bootstrap is None or time.monotonic() - _bootstrap[0] > 86400:
        async with session.get(IANA_RDAP_BOOTSTRAP) as resp:
            doc = await resp.json(content_type=None)
        mapping = {}
        for svc in doc.get("services", []):
            for t in svc[0]:
                if svc[1]:
                    mapping[t.lower()] = svc[1][0]
        _bootstrap = (time.monotonic(), mapping)
    return _bootstrap[1].get(tld)


async def _whois_query(server: str, query: str, timeout: float) -> str:
    reader, writer = await asyncio.wait_for(asyncio.open_connection(server, 43), timeout=timeout)
    try:
        writer.write((query + "\r\n").encode())
        await writer.drain()
        data = await asyncio.wait_for(reader.read(200_000), timeout=timeout)
        buf = data
        while data and len(buf) < 200_000:
            data = await asyncio.wait_for(reader.read(200_000), timeout=timeout)
            buf += data
        return buf.decode("utf-8", errors="replace")
    finally:
        writer.close()


async def _whois_server(tld: str, timeout: float) -> str | None:
    if tld not in _whois_servers:
        text = await _whois_query(IANA_WHOIS, tld, timeout)
        m = re.search(r"^whois:\s*(\S+)", text, re.MULTILINE)
        if not m:
            return None
        _whois_servers[tld] = m.group(1)
    return _whois_servers[tld]


async def lookup(domain: str, timeout: float) -> tuple[dict[str, Any], str, list[str]]:
    """Return (info, source, errors). info may lack expires_at when nothing could be determined."""
    tld = domain.rsplit(".", 1)[-1]
    errors: list[str] = []
    headers = {"Accept": "application/rdap+json", "User-Agent": get_settings().probe_user_agent}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), headers=headers) as session:
            base = await _rdap_base(session, tld)
            if base:
                async with session.get(f"{base.rstrip('/')}/domain/{domain}") as resp:
                    if resp.status == 200:
                        info = parse_rdap(json.loads(await resp.text()))
                        if info.get("expires_at"):
                            return info, "rdap", errors
                        errors.append("RDAP response had no expiration date")
                    elif resp.status == 404:
                        return {"not_found": True}, "rdap", errors
                    else:
                        errors.append(f"RDAP HTTP {resp.status}")
            else:
                errors.append("no RDAP service for this TLD")
    except (aiohttp.ClientError, TimeoutError, ValueError) as exc:
        errors.append(f"RDAP error: {exc.__class__.__name__}")
    try:
        server = await _whois_server(tld, timeout)
        if not server:
            errors.append("no WHOIS server for this TLD")
            return {}, "", errors
        text = await _whois_query(server, domain, timeout)
        if re.search(r"(no match|not found|no entries found|no data found|domain not found|status:\s*free)", text,
                     re.IGNORECASE):
            return {"not_found": True}, f"whois:{server}", errors
        info = parse_whois(text)
        if not info.get("expires_at"):
            errors.append(f"WHOIS ({server}) did not include an expiry date")
        return info, f"whois:{server}", errors
    except (OSError, TimeoutError) as exc:
        errors.append(f"WHOIS error: {exc.__class__.__name__}")
        return {}, "", errors


async def probe_domain(cfg: DomainConfig, ctx: ProbeContext) -> ProbeResult:
    t = Timer()
    info, source, errors = await lookup(cfg.domain, min(ctx.timeout, 20))
    elapsed = t.ms()
    if info.get("not_found"):
        return ProbeResult.down(f"domain {cfg.domain} is not registered (or registration lapsed)",
                                latency_ms=elapsed, details={"domain": {"name": cfg.domain, "source": source}})
    exp: datetime | None = info.get("expires_at")
    if exp is None:
        return ProbeResult.unknown(("could not determine expiry: " + "; ".join(errors))[:500], latency_ms=elapsed,
                                   details={"domain": {"name": cfg.domain, "source": source, "errors": errors}})
    now = datetime.now(UTC)
    seconds = (exp - now).total_seconds()
    days = int(seconds // 86400)
    dom = {
        "name": cfg.domain, "expires_at": exp.isoformat(), "days_remaining": days, "expired": seconds < 0,
        "registrar": info.get("registrar"), "nameservers": info.get("nameservers", []),
        "status": info.get("status", []), "source": source,
    }
    if seconds < 0:
        return ProbeResult.down(f"domain {cfg.domain} expired on {exp.date().isoformat()}", latency_ms=elapsed,
                                details={"domain": dom})
    return ProbeResult(CheckOutcomeStatus.UP, f"{cfg.domain} expires {exp.date().isoformat()} ({days} days)",
                       latency_ms=elapsed, details={"domain": dom}, metrics=[("domain_days_remaining", cfg.domain, float(days))])
