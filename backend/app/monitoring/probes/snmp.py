"""SNMP v1/v2c/v3 polling for network devices (system info + interface counters).

Only read operations (GET / GETBULK) are used; numeric OIDs avoid MIB compilation.
Interface throughput is computed from 64-bit counter deltas between consecutive polls.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.models.enums import CheckOutcomeStatus
from app.monitoring.check_configs import SnmpConfig, SnmpSecrets
from app.monitoring.probes.base import ProbeContext, ProbeResult, Timer
from app.monitoring.probes.net import _guarded_addrs

SYS_DESCR = "1.3.6.1.2.1.1.1.0"
SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
SYS_NAME = "1.3.6.1.2.1.1.5.0"
IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
IF_OPER = "1.3.6.1.2.1.2.2.1.8"
IF_HC_IN = "1.3.6.1.2.1.31.1.1.1.6"
IF_HC_OUT = "1.3.6.1.2.1.31.1.1.1.10"
IF_IN_ERR = "1.3.6.1.2.1.2.2.1.14"
IF_OUT_ERR = "1.3.6.1.2.1.2.2.1.20"
COUNTER64_MAX = 2**64


def counter_rate(prev: float | None, cur: float, seconds: float, wrap: int = COUNTER64_MAX) -> float | None:
    """Per-second rate between two counter readings; None when no valid baseline exists."""
    if prev is None or seconds <= 0:
        return None
    delta = cur - prev
    if delta < 0:
        if prev <= wrap * 0.9:  # counter reset (device reboot) — no meaningful rate this interval
            return None
        delta = cur + (wrap - prev)  # genuine wrap-around near the counter maximum
    return delta / seconds


def _auth(cfg: SnmpConfig, secrets: SnmpSecrets | None) -> Any:
    from pysnmp.hlapi.v3arch.asyncio import (
        CommunityData,
        UsmUserData,
        usmAesCfb128Protocol,
        usmAesCfb256Protocol,
        usmDESPrivProtocol,
        usmHMAC192SHA256AuthProtocol,
        usmHMAC384SHA512AuthProtocol,
        usmHMACMD5AuthProtocol,
        usmHMACSHAAuthProtocol,
        usmNoAuthProtocol,
        usmNoPrivProtocol,
    )

    if cfg.version in ("1", "2c"):
        community = (secrets.community if secrets else None) or "public"
        return CommunityData(community, mpModel=0 if cfg.version == "1" else 1)
    auth_proto = {
        "none": usmNoAuthProtocol, "md5": usmHMACMD5AuthProtocol, "sha": usmHMACSHAAuthProtocol,
        "sha256": usmHMAC192SHA256AuthProtocol, "sha512": usmHMAC384SHA512AuthProtocol,
    }[cfg.v3_auth_protocol]
    priv_proto = {
        "none": usmNoPrivProtocol, "des": usmDESPrivProtocol, "aes128": usmAesCfb128Protocol,
        "aes256": usmAesCfb256Protocol,
    }[cfg.v3_priv_protocol]
    level = cfg.v3_security_level
    return UsmUserData(
        cfg.v3_username or "",
        authKey=(secrets.v3_auth_key if secrets else None) if level != "noAuthNoPriv" else None,
        privKey=(secrets.v3_priv_key if secrets else None) if level == "authPriv" else None,
        authProtocol=auth_proto if level != "noAuthNoPriv" else usmNoAuthProtocol,
        privProtocol=priv_proto if level == "authPriv" else usmNoPrivProtocol,
    )


async def probe_snmp(cfg: SnmpConfig, ctx: ProbeContext) -> ProbeResult:
    from pysnmp.hlapi.v3arch.asyncio import (
        ContextData,
        ObjectIdentity,
        ObjectType,
        SnmpEngine,
        Udp6TransportTarget,
        UdpTransportTarget,
        bulk_walk_cmd,
        get_cmd,
    )

    addrs = await _guarded_addrs(cfg.host, ctx, cfg.port)
    if isinstance(addrs, ProbeResult):
        return addrs
    ip = addrs[0]
    engine = SnmpEngine()
    auth = _auth(cfg, ctx.secrets)
    target_cls = Udp6TransportTarget if ":" in ip else UdpTransportTarget
    transport = await target_cls.create((ip, cfg.port), timeout=max(1.0, ctx.timeout / 2), retries=1)
    t = Timer()
    try:
        err_ind, err_status, _, binds = await get_cmd(
            engine, auth, transport, ContextData(),
            ObjectType(ObjectIdentity(SYS_DESCR)), ObjectType(ObjectIdentity(SYS_UPTIME)),
            ObjectType(ObjectIdentity(SYS_NAME)),
        )
        if err_ind:
            return ProbeResult.down(f"SNMP: {err_ind}")
        if err_status:
            return ProbeResult.down(f"SNMP error: {err_status.prettyPrint()}")
        latency = t.ms()
        sysvals = {str(oid): val for oid, val in binds}
        uptime_ticks = int(sysvals.get(SYS_UPTIME, 0) or 0)
        details: dict[str, Any] = {
            "sys_descr": str(sysvals.get(SYS_DESCR, ""))[:300],
            "sys_name": str(sysvals.get(SYS_NAME, ""))[:120],
            "uptime_seconds": uptime_ticks // 100,
        }
        metrics: list[tuple[str, str, float]] = [("uptime_seconds", "", float(uptime_ticks // 100)),
                                                 ("snmp_latency_ms", "", latency)]
        if cfg.collect_interfaces:
            tables: dict[str, dict[str, Any]] = {}
            for base in (IF_DESCR, IF_OPER, IF_HC_IN, IF_HC_OUT, IF_IN_ERR, IF_OUT_ERR):
                col: dict[str, Any] = {}
                async for e_ind, e_stat, _, vbs in bulk_walk_cmd(
                    engine, auth, transport, ContextData(), 0, 25, ObjectType(ObjectIdentity(base)),
                    lexicographicMode=False,
                ):
                    if e_ind or e_stat:
                        break
                    for oid, val in vbs:
                        idx = str(oid).rsplit(".", 1)[-1]
                        col[idx] = val
                    if len(col) >= cfg.max_interfaces:
                        break
                tables[base] = col
            now = datetime.now(UTC)
            prev = ctx.previous.get("if_counters", {}) if ctx.previous else {}
            prev_ts = ctx.previous.get("if_counters_ts") if ctx.previous else None
            elapsed_s = (now - datetime.fromisoformat(prev_ts)).total_seconds() if prev_ts else 0
            counters: dict[str, list[float]] = {}
            interfaces = []
            up_count = 0
            for idx, descr in list(tables[IF_DESCR].items())[: cfg.max_interfaces]:
                name = str(descr)[:64]
                oper = int(tables[IF_OPER].get(idx, 0) or 0)
                is_up = 1.0 if oper == 1 else 0.0
                up_count += int(is_up)
                metrics.append(("if_up", name, is_up))
                entry: dict[str, Any] = {"index": idx, "name": name, "oper_status": "up" if oper == 1 else "down"}
                if idx in tables[IF_HC_IN] and idx in tables[IF_HC_OUT]:
                    cin, cout = float(int(tables[IF_HC_IN][idx])), float(int(tables[IF_HC_OUT][idx]))
                    counters[idx] = [cin, cout]
                    p = prev.get(idx)
                    rin = counter_rate(p[0] if p else None, cin, elapsed_s)
                    rout = counter_rate(p[1] if p else None, cout, elapsed_s)
                    if rin is not None:
                        metrics.append(("net_rx_bytes_ps", name, rin))
                        entry["rx_bps"] = round(rin * 8, 1)
                    if rout is not None:
                        metrics.append(("net_tx_bytes_ps", name, rout))
                        entry["tx_bps"] = round(rout * 8, 1)
                for oid, mname in ((IF_IN_ERR, "if_in_errors"), (IF_OUT_ERR, "if_out_errors")):
                    if idx in tables[oid]:
                        metrics.append((mname, name, float(int(tables[oid][idx]))))
                interfaces.append(entry)
            details["interfaces"] = interfaces
            details["interfaces_up"] = up_count
            details["if_counters"] = counters
            details["if_counters_ts"] = now.isoformat()
    except (TimeoutError, OSError) as exc:
        return ProbeResult.down(f"SNMP request failed: {exc}")
    finally:
        engine.close_dispatcher()
    return ProbeResult(CheckOutcomeStatus.UP, f"SNMP reachable ({latency:.0f} ms), {details['sys_name'] or 'device'}",
                       latency_ms=latency, details=details, metrics=metrics)
