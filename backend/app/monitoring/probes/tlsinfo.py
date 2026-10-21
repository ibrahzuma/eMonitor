"""Certificate inspection helpers shared by HTTP and TLS probes."""

from __future__ import annotations

import ssl
from datetime import UTC, datetime
from typing import Any

from cryptography import x509
from cryptography.x509.oid import ExtensionOID, NameOID


def describe_certificate(der: bytes | None, now: datetime | None = None) -> dict[str, Any]:
    if not der:
        return {}
    now = now or datetime.now(UTC)
    cert = x509.load_der_x509_certificate(der)
    not_after = cert.not_valid_after_utc
    not_before = cert.not_valid_before_utc

    def _cn(name: x509.Name) -> str:
        attrs = name.get_attributes_for_oid(NameOID.COMMON_NAME)
        return str(attrs[0].value) if attrs else name.rfc4514_string()

    sans: list[str] = []
    try:
        ext = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME)
        sans = [str(n) for n in ext.value.get_values_for_type(x509.DNSName)][:50]
    except x509.ExtensionNotFound:
        pass
    seconds_left = (not_after - now).total_seconds()
    return {
        "subject": _cn(cert.subject),
        "issuer": _cn(cert.issuer),
        "serial": format(cert.serial_number, "x"),
        "not_before": not_before.isoformat(),
        "not_after": not_after.isoformat(),
        "days_remaining": int(seconds_left // 86400) if seconds_left >= 0 else -int((-seconds_left) // 86400) - 1,
        "expired": seconds_left < 0,
        "not_yet_valid": not_before > now,
        "sans": sans,
        "signature_algorithm": getattr(cert.signature_hash_algorithm, "name", None),
    }


def hostname_matches(cert_info: dict[str, Any], hostname: str) -> bool:
    names = [n.lower() for n in cert_info.get("sans") or []] or [str(cert_info.get("subject", "")).lower()]
    h = hostname.lower().rstrip(".")
    for n in names:
        if n == h:
            return True
        if n.startswith("*.") and h.count(".") >= 1 and h.split(".", 1)[1] == n[2:]:
            return True
    return False


def verification_context() -> ssl.SSLContext:
    return ssl.create_default_context()


def insecure_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx
