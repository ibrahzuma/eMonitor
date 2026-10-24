"""Operating-system metric collection.

Only fixed, allowlisted read operations are performed: reading /proc and /sys files, statvfs on
mounted filesystems, and a read-only service-status query (`systemctl is-active`, OpenRC
`rc-service status`, or SysVinit `service status`, chosen by the host's init system) for units
listed in the local config. The agent never executes commands received from the server.

Parsers are pure functions over file contents so they can be unit-tested on any platform.
`Collector` is the platform interface; `LinuxCollector` implements it (Windows can be added later).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

log = logging.getLogger("emonitor-agent.collectors")

Metric = tuple[str, str, float]  # (name, instance, value)

PSEUDO_FS = {"proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "pstore", "bpf", "tracefs",
             "debugfs", "securityfs", "configfs", "fusectl", "mqueue", "hugetlbfs", "autofs", "squashfs", "overlay",
             "nsfs", "ramfs", "rpc_pipefs", "efivarfs", "binfmt_misc", "fuse.lxcfs", "fuse.snapfuse"}
DISK_DEVICE = re.compile(r"^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|hd[a-z]+|mmcblk\d+|dm-\d+|md\d+)$")
SERVICE_NAME = re.compile(r"^[A-Za-z0-9@._\-]{1,128}$")


# ------------------------------------------------------------------ pure parsers

def parse_cpu_times(stat: str) -> list[int]:
    for line in stat.splitlines():
        if line.startswith("cpu "):
            return [int(x) for x in line.split()[1:]]
    raise ValueError("no aggregate cpu line")


def cpu_percent(prev: list[int], cur: list[int]) -> tuple[float, float]:
    """Return (busy %, iowait %) between two /proc/stat samples."""
    d = [c - p for c, p in zip(cur, prev, strict=False)]
    total = sum(d[:8])  # user nice system idle iowait irq softirq steal (guest is included in user)
    if total <= 0:
        return 0.0, 0.0
    idle = d[3] + (d[4] if len(d) > 4 else 0)
    iowait = d[4] if len(d) > 4 else 0
    return round(100.0 * (total - idle) / total, 2), round(100.0 * iowait / total, 2)


def parse_meminfo(text: str) -> dict[str, int]:
    out = {}
    for line in text.splitlines():
        m = re.match(r"^(\w+):\s+(\d+)(?:\s+kB)?", line)
        if m:
            out[m.group(1)] = int(m.group(2)) * 1024
    return out


def memory_metrics(mi: dict[str, int]) -> list[Metric]:
    total = mi.get("MemTotal", 0)
    avail = mi.get("MemAvailable", mi.get("MemFree", 0) + mi.get("Buffers", 0) + mi.get("Cached", 0))
    out: list[Metric] = []
    if total:
        used = total - avail
        out += [("memory_total_bytes", "", float(total)), ("memory_available_bytes", "", float(avail)),
                ("memory_used_bytes", "", float(used)), ("memory_percent", "", round(100.0 * used / total, 2))]
    st = mi.get("SwapTotal", 0)
    if st:
        out.append(("swap_percent", "", round(100.0 * (st - mi.get("SwapFree", 0)) / st, 2)))
    return out


def parse_loadavg(text: str) -> list[Metric]:
    parts = text.split()
    running, total = parts[3].split("/")
    return [("load1", "", float(parts[0])), ("load5", "", float(parts[1])), ("load15", "", float(parts[2])),
            ("procs_running", "", float(running))]


def parse_uptime(text: str) -> float:
    return float(text.split()[0])


def parse_diskstats(text: str) -> dict[str, tuple[int, int, int, int]]:
    """device → (reads completed, sectors read, writes completed, sectors written)."""
    out = {}
    for line in text.splitlines():
        p = line.split()
        if len(p) >= 10 and DISK_DEVICE.match(p[2]):
            out[p[2]] = (int(p[3]), int(p[5]), int(p[7]), int(p[9]))
    return out


def disk_io_rates(prev: dict, cur: dict, seconds: float) -> list[Metric]:
    out: list[Metric] = []
    if seconds <= 0:
        return out
    for dev, c in cur.items():
        p = prev.get(dev)
        if not p or any(c[i] < p[i] for i in range(4)):
            continue
        out += [("disk_read_iops", dev, round((c[0] - p[0]) / seconds, 2)),
                ("disk_read_bytes_ps", dev, round((c[1] - p[1]) * 512 / seconds, 1)),
                ("disk_write_iops", dev, round((c[2] - p[2]) / seconds, 2)),
                ("disk_write_bytes_ps", dev, round((c[3] - p[3]) * 512 / seconds, 1))]
    return out


def parse_net_dev(text: str) -> dict[str, tuple[int, int, int, int]]:
    """iface → (rx bytes, rx errors, tx bytes, tx errors)."""
    out = {}
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        name, data = line.split(":", 1)
        f = data.split()
        name = name.strip()
        if name == "lo" or len(f) < 16:
            continue
        out[name] = (int(f[0]), int(f[2]), int(f[8]), int(f[10]))
    return out


def net_rates(prev: dict, cur: dict, seconds: float) -> list[Metric]:
    out: list[Metric] = []
    if seconds <= 0:
        return out
    for iface, c in cur.items():
        p = prev.get(iface)
        if not p or any(c[i] < p[i] for i in range(4)):
            continue
        out += [("net_rx_bytes_ps", iface, round((c[0] - p[0]) / seconds, 1)),
                ("net_tx_bytes_ps", iface, round((c[2] - p[2]) / seconds, 1)),
                ("net_rx_errors_ps", iface, round((c[1] - p[1]) / seconds, 3)),
                ("net_tx_errors_ps", iface, round((c[3] - p[3]) / seconds, 3))]
    return out


def parse_mounts(text: str) -> list[tuple[str, str, str]]:
    """Return (device, mountpoint, fstype) for real filesystems."""
    seen, out = set(), []
    for line in text.splitlines():
        p = line.split()
        if len(p) < 3 or p[2] in PSEUDO_FS or p[1].startswith(("/proc", "/sys", "/dev", "/run", "/snap")):
            continue
        mp = p[1].replace("\\040", " ")
        if p[0] in seen:
            continue
        seen.add(p[0])
        out.append((p[0], mp, p[2]))
    return out


def count_tcp(text: str) -> int:
    return max(0, len(text.splitlines()) - 1)


# ------------------------------------------------------------------ service status (init systems)
#
# Different Linux distributions use different init/service managers, so the agent probes service
# state through whichever one is in charge of the host. The command built for each unit is fixed
# and read-only; `status`/`is-active` never start, stop, or change a service.


def detect_init_system(which: Callable[[str], str | None] = shutil.which,
                       systemd_run: str = "/run/systemd/system", initd: str = "/etc/init.d") -> str:
    """Return the host's service manager: 'systemd', 'openrc', 'sysvinit', or 'unknown'."""
    if os.path.isdir(systemd_run):  # the canonical "systemd is PID 1" marker
        return "systemd"
    if which("rc-service"):  # OpenRC (Alpine, Gentoo)
        return "openrc"
    if os.path.isdir(initd) and os.listdir(initd):  # legacy SysVinit scripts
        return "sysvinit"
    return "unknown"


def service_up_systemd(rc: int, out: str, err: str) -> bool:
    return out.strip() == "active"


def service_up_openrc(rc: int, out: str, err: str) -> bool:
    """OpenRC `rc-service <unit> status`: exit 0 when started; text 'status: started|stopped|crashed'."""
    low = out.lower()
    if re.search(r"status:\s*started", low):
        return True
    if "stopped" in low or "crashed" in low or "inactive" in low:
        return False
    return rc == 0


def service_up_sysvinit(rc: int, out: str, err: str) -> bool:
    """LSB `service <unit> status`: exit 0 when running; wording varies across init scripts."""
    low = out.lower()
    if "not running" in low or "stopped" in low or "dead" in low or "inactive" in low:
        return False
    if "is running" in low or re.search(r"\brunning\b", low):
        return True
    return rc == 0


# unit → argv (read-only status query), and (rc, stdout, stderr) → is-up, per init system.
INIT_COMMANDS: dict[str, Callable[[str], list[str]]] = {
    "systemd": lambda unit: ["systemctl", "is-active", "--", unit],
    "openrc": lambda unit: ["rc-service", unit, "status"],
    "sysvinit": lambda unit: ["service", unit, "status"],
}
INIT_PARSERS: dict[str, Callable[[int, str, str], bool]] = {
    "systemd": service_up_systemd,
    "openrc": service_up_openrc,
    "sysvinit": service_up_sysvinit,
}


# ------------------------------------------------------------------ collectors

class Collector(Protocol):
    def system_info(self) -> dict: ...
    def collect(self) -> list[Metric]: ...


@dataclass
class LinuxCollector:
    services: list[str] = field(default_factory=list)
    proc: str = "/proc"
    sys: str = "/sys"
    _prev_cpu: list[int] | None = None
    _prev_disk: dict = field(default_factory=dict)
    _prev_net: dict = field(default_factory=dict)
    _prev_t: float | None = None
    _init: str | None = None
    _warned_init: bool = False

    def __post_init__(self) -> None:
        self.services = [s for s in self.services if SERVICE_NAME.match(s)]

    def init_system(self) -> str:
        """Detect the service manager once and cache it for the process lifetime."""
        if self._init is None:
            self._init = detect_init_system()
            log.info("service monitoring via init system: %s", self._init)
        return self._init

    def _read(self, rel: str) -> str:
        with open(os.path.join(self.proc, rel), encoding="utf-8", errors="replace") as fh:
            return fh.read()

    def system_info(self) -> dict:
        info: dict = {"cpu_count": os.cpu_count()}
        try:
            info["memory_total_bytes"] = parse_meminfo(self._read("meminfo")).get("MemTotal")
            info["uptime_seconds"] = int(parse_uptime(self._read("uptime")))
            info["kernel"] = self._read("sys/kernel/osrelease").strip()
        except OSError:
            pass
        try:
            with open("/etc/os-release", encoding="utf-8") as fh:
                m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', fh.read(), re.M)
                if m:
                    info["os_version"] = m.group(1)
        except OSError:
            pass
        return info

    def collect(self) -> list[Metric]:
        now = time.monotonic()
        elapsed = now - self._prev_t if self._prev_t else 0.0
        out: list[Metric] = []
        cpu = parse_cpu_times(self._read("stat"))
        if self._prev_cpu:
            busy, iowait = cpu_percent(self._prev_cpu, cpu)
            out += [("cpu_percent", "", busy), ("cpu_iowait_percent", "", iowait)]
        self._prev_cpu = cpu
        out += memory_metrics(parse_meminfo(self._read("meminfo")))
        out += parse_loadavg(self._read("loadavg"))
        out.append(("uptime_seconds", "", round(parse_uptime(self._read("uptime")))))
        disks = parse_diskstats(self._read("diskstats"))
        out += disk_io_rates(self._prev_disk, disks, elapsed)
        self._prev_disk = disks
        nets = parse_net_dev(self._read("net/dev"))
        out += net_rates(self._prev_net, nets, elapsed)
        self._prev_net = nets
        for iface in nets:
            try:
                with open(os.path.join(self.sys, "class/net", iface, "operstate"), encoding="utf-8") as fh:
                    out.append(("net_if_up", iface, 1.0 if fh.read().strip() in ("up", "unknown") else 0.0))
            except OSError:
                pass
        for _dev, mp, _fs in parse_mounts(self._read("mounts")):
            try:
                st = os.statvfs(mp)
            except (OSError, AttributeError):  # AttributeError: non-POSIX platform
                continue
            total = st.f_blocks * st.f_frsize
            if total <= 0:
                continue
            free = st.f_bavail * st.f_frsize
            used = total - st.f_bfree * st.f_frsize
            out += [("disk_total_bytes", mp, float(total)), ("disk_free_bytes", mp, float(free)),
                    ("disk_used_bytes", mp, float(used)),
                    ("disk_percent", mp, round(100.0 * used / max(1, used + free), 2))]
            if st.f_files:
                out.append(("inode_percent", mp, round(100.0 * (st.f_files - st.f_ffree) / st.f_files, 2)))
        out.append(("process_count", "", float(sum(1 for d in os.listdir(self.proc) if d.isdigit()))))
        try:
            out.append(("tcp_connections", "", float(count_tcp(self._read("net/tcp")) +
                                                    count_tcp(self._read("net/tcp6")))))
        except OSError:
            pass
        out += self.service_states()
        self._prev_t = now
        return out

    def service_states(self) -> list[Metric]:
        out: list[Metric] = []
        if not self.services:
            return out
        init = self.init_system()
        build, parse = INIT_COMMANDS.get(init), INIT_PARSERS.get(init)
        if build is None or parse is None:
            # No recognised init system: skip rather than report every unit as down (false alarms).
            if not self._warned_init:
                log.warning("no supported init system detected; skipping %d configured service(s)",
                            len(self.services))
                self._warned_init = True
            return out
        for unit in self.services:
            try:
                r = subprocess.run(build(unit), capture_output=True, text=True, timeout=5, check=False)
                out.append(("service_up", unit, 1.0 if parse(r.returncode, r.stdout or "", r.stderr or "") else 0.0))
            except (OSError, subprocess.TimeoutExpired):
                out.append(("service_up", unit, 0.0))
        return out


def get_collector(services: list[str]) -> Collector:
    import platform

    if platform.system() == "Linux":
        return LinuxCollector(services=services)
    raise RuntimeError(f"unsupported platform {platform.system()} (Linux only in this release)")
