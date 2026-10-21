"""Outbound target authorization (SSRF / unauthorized-scanning protection).

Every probe and outbound webhook resolves its target through `authorize()`, which returns the
list of permitted IP addresses. Connections are then made to those addresses only (resolver
pinning), so a DNS answer that changes between validation and connection cannot redirect a
probe to an internal service.

Policy (per organization ``monitoring_scope``):
    {"allow_public": true, "cidrs": ["10.20.0.0/16"], "hostnames": ["example.com", ".corp.example"]}

* Addresses in ALWAYS_DENIED (cloud metadata, link-local, multicast, unspecified …) are never
  reachable, regardless of scope.
* Platform-blocked CIDRs (``EMONITOR_PROBE_BLOCKED_CIDRS``, e.g. the platform's own database
  network) are never reachable.
* Non-public addresses (RFC1918, loopback, CGNAT, ULA …) are reachable only if contained in one of
  the organization's ``cidrs`` and the platform allows private targets.
* Public addresses are reachable if ``allow_public`` is true, or the hostname matches
  ``hostnames``, or the address is within ``cidrs``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from dataclasses import dataclass, field
from typing import Any

from app.core.config import get_settings

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

ALWAYS_DENIED: tuple[IPNetwork, ...] = tuple(
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",  # "this" network
        "169.254.0.0/16",  # link-local incl. 169.254.169.254 metadata (AWS/GCP/Azure/OpenStack)
        "100.100.100.200/32",  # Alibaba Cloud metadata
        "192.0.0.0/24",  # IETF protocol assignments (incl. 192.0.0.192 Oracle metadata)
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved
        "255.255.255.255/32",
        "::/128",
        "fe80::/10",  # IPv6 link-local
        "ff00::/8",  # IPv6 multicast
        "fd00:ec2::254/128",  # AWS IPv6 metadata
        "64:ff9b::/96",  # NAT64 (could map to internal v4)
        "2001:db8::/32",  # documentation
    )
)


class TargetNotAllowed(Exception):
    """Raised when a target is outside the authorized monitoring scope."""


@dataclass(frozen=True)
class Scope:
    allow_public: bool = True
    cidrs: tuple[IPNetwork, ...] = ()
    hostnames: tuple[str, ...] = ()
    blocked: tuple[IPNetwork, ...] = field(default_factory=tuple)
    allow_private: bool = True

    @classmethod
    def from_org(cls, monitoring_scope: dict[str, Any] | None) -> Scope:
        ms = monitoring_scope or {}
        s = get_settings()
        cidrs = []
        for c in ms.get("cidrs", []) or []:
            try:
                cidrs.append(ipaddress.ip_network(str(c), strict=False))
            except ValueError:
                continue
        blocked = []
        for c in os.environ.get("EMONITOR_PROBE_BLOCKED_CIDRS", "").split(","):
            if c.strip():
                blocked.append(ipaddress.ip_network(c.strip(), strict=False))
        hostnames = tuple(h.strip().lower() for h in (ms.get("hostnames") or []) if h and h.strip())
        return cls(
            allow_public=bool(ms.get("allow_public", True)),
            cidrs=tuple(cidrs),
            hostnames=hostnames,
            blocked=tuple(blocked),
            allow_private=s.allow_private_targets,
        )


def _unmap(ip: IPAddress) -> IPAddress:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def is_public(ip: IPAddress) -> bool:
    return ip.is_global and not ip.is_multicast


def hostname_in_scope(hostname: str, scope: Scope) -> bool:
    h = hostname.lower().rstrip(".")
    for pattern in scope.hostnames:
        if pattern.startswith("."):
            if h.endswith(pattern) or h == pattern[1:]:
                return True
        elif h == pattern or h.endswith("." + pattern):
            return True
    return False


def check_ip(ip: IPAddress, scope: Scope, hostname: str | None = None) -> None:
    ip = _unmap(ip)
    for net in ALWAYS_DENIED:
        if ip.version == net.version and ip in net:
            raise TargetNotAllowed(f"address {ip} is in a permanently blocked range ({net})")
    for net in scope.blocked:
        if ip.version == net.version and ip in net:
            raise TargetNotAllowed(f"address {ip} is blocked by platform policy")
    in_cidrs = any(ip.version == n.version and ip in n for n in scope.cidrs)
    if not is_public(ip):
        if in_cidrs and scope.allow_private:
            return
        raise TargetNotAllowed(
            f"address {ip} is a private/internal address not in the organization's authorized networks"
        )
    if scope.allow_public or in_cidrs or (hostname and hostname_in_scope(hostname, scope)):
        return
    raise TargetNotAllowed(f"target {hostname or ip} is outside the organization's authorized monitoring scope")


def parse_ip(value: str) -> IPAddress | None:
    try:
        return ipaddress.ip_address(value.strip("[]"))
    except ValueError:
        return None


def validate_hostname_syntax(host: str) -> str:
    h = host.strip().rstrip(".").lower()
    if not h or len(h) > 253:
        raise TargetNotAllowed("invalid hostname")
    if parse_ip(h):
        return h
    for label in h.split("."):
        if not label or len(label) > 63 or not all(c.isalnum() or c in "-_" for c in label) or label.startswith("-"):
            raise TargetNotAllowed(f"invalid hostname {host!r}")
    return h


async def resolve(host: str, port: int | None = None) -> list[IPAddress]:
    ip = parse_ip(host)
    if ip:
        return [ip]
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port or 0, type=socket.SOCK_STREAM)
    seen: list[IPAddress] = []
    for info in infos:
        addr = ipaddress.ip_address(info[4][0].split("%")[0])
        if addr not in seen:
            seen.append(addr)
    return seen


async def authorize(host: str, scope: Scope, port: int | None = None) -> list[IPAddress]:
    """Resolve `host` and return only addresses permitted by `scope`.

    Raises TargetNotAllowed if *any* resolved address is forbidden: a hostname that resolves to a
    mix of public and internal addresses is treated as hostile.
    """
    h = validate_hostname_syntax(host)
    if not parse_ip(h):
        _check_hostname_policy(h, scope)
    try:
        addrs = await resolve(h, port)
    except (socket.gaierror, UnicodeError) as exc:
        raise ResolutionError(f"DNS resolution failed for {h}: {exc}") from exc
    if not addrs:
        raise ResolutionError(f"DNS resolution returned no addresses for {h}")
    for a in addrs:
        check_ip(a, scope, None if parse_ip(h) else h)
    return addrs


def static_validate(host: str, scope: Scope) -> None:
    """Configuration-time validation without DNS (DNS is re-checked at execution time)."""
    h = validate_hostname_syntax(host)
    ip = parse_ip(h)
    if ip:
        check_ip(ip, scope)
        return
    _check_hostname_policy(h, scope)


def _check_hostname_policy(h: str, scope: Scope) -> None:
    if h == "localhost" or h.endswith(".localhost"):
        raise TargetNotAllowed("localhost targets are not allowed")
    # *.internal is used for cloud metadata (metadata.google.internal); must be listed explicitly.
    if h.endswith(".internal") and not hostname_in_scope(h, scope):
        raise TargetNotAllowed("*.internal hostnames must be explicitly listed in the monitoring scope")
    if not scope.allow_public and not hostname_in_scope(h, scope) and not scope.cidrs:
        raise TargetNotAllowed(f"target {h} is outside the organization's authorized monitoring scope")


class ResolutionError(Exception):
    """DNS failure (a monitoring result, not a policy violation)."""
