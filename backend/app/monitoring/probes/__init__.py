"""Probe dispatch: run one check configuration and return a ProbeResult. Never raises."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from app.models.enums import CheckType
from app.monitoring.check_configs import parse_config
from app.monitoring.probes.base import ProbeContext, ProbeResult

log = logging.getLogger("emonitor.probes")


def _registry() -> dict[str, Callable[[Any, ProbeContext], Awaitable[ProbeResult]]]:
    from app.monitoring.probes.db import probe_mysql, probe_postgres, probe_redis
    from app.monitoring.probes.domain import probe_domain
    from app.monitoring.probes.http import probe_http
    from app.monitoring.probes.net import probe_dns, probe_icmp, probe_smtp, probe_ssh, probe_tcp, probe_tls
    from app.monitoring.probes.snmp import probe_snmp

    return {
        CheckType.HTTP: probe_http,
        CheckType.TCP: probe_tcp,
        CheckType.ICMP: probe_icmp,
        CheckType.DNS: probe_dns,
        CheckType.TLS: probe_tls,
        CheckType.SMTP: probe_smtp,
        CheckType.SSH: probe_ssh,
        CheckType.POSTGRES: probe_postgres,
        CheckType.MYSQL: probe_mysql,
        CheckType.REDIS: probe_redis,
        CheckType.SNMP: probe_snmp,
        CheckType.DOMAIN: probe_domain,
    }


async def run_probe(check_type: str, config: dict[str, Any], ctx: ProbeContext) -> ProbeResult:
    try:
        cfg = parse_config(check_type, config)
    except Exception as exc:
        return ProbeResult.unknown(f"invalid check configuration: {exc}"[:500])
    probe = _registry().get(check_type)
    if probe is None:
        return ProbeResult.unknown(f"unsupported check type {check_type}")
    try:
        # Hard ceiling in addition to per-operation timeouts inside each probe.
        return await asyncio.wait_for(probe(cfg, ctx), timeout=ctx.timeout + 5)
    except TimeoutError:
        return ProbeResult.down(f"check exceeded its timeout ({ctx.timeout:g}s)")
    except Exception as exc:  # a probe bug must not crash the worker or count as downtime
        log.exception("probe crashed", extra={"check_type": check_type})
        return ProbeResult.unknown(f"internal probe error: {exc.__class__.__name__}")


__all__ = ["ProbeContext", "ProbeResult", "run_probe"]
