"""Agent unit tests: parsers, spool bounds, log tailing, delivery/backoff behaviour.

Run: python -m pytest agent/tests (stdlib + pytest only).
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from monitor_agent import collectors as col  # noqa: E402
from monitor_agent.agent import Agent, Config, write_credentials  # noqa: E402
from monitor_agent.logtail import LogTailer, guess_severity, to_record  # noqa: E402
from monitor_agent.spool import Spool  # noqa: E402
from monitor_agent.transport import Transport, TransportError, backoff_delay  # noqa: E402

STAT1 = "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0\n"
STAT2 = "cpu  150 0 150 850 50 0 0 0 0 0\n"
MEMINFO = """MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    2000000 kB
Buffers:          100000 kB
Cached:           900000 kB
SwapTotal:       1000000 kB
SwapFree:         750000 kB
"""
NETDEV = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
  eth0: 1000 10 1 0 0 0 0 0 2000 20 0 0 0 0 0 0
"""
NETDEV2 = NETDEV.replace("eth0: 1000 10 1", "eth0: 11000 10 3").replace("0 2000 20", "0 4000 20")
DISKSTATS = "   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0\n   7       0 loop0 1 0 1 0 0 0 0 0 0 0 0\n"
DISKSTATS2 = "   8       0 sda 200 0 4000 0 150 0 8000 0 0 0 0\n"
MOUNTS = """/dev/sda1 / ext4 rw 0 0
proc /proc proc rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/sdb1 /var/lib/data xfs rw 0 0
/dev/sda1 /mnt/bind ext4 rw 0 0
"""


def test_cpu_memory_load_parsers():
    busy, iowait = col.cpu_percent(col.parse_cpu_times(STAT1), col.parse_cpu_times(STAT2))
    assert busy == 50.0 and iowait == 25.0
    m = dict(((n, i), v) for n, i, v in col.memory_metrics(col.parse_meminfo(MEMINFO)))
    assert m[("memory_percent", "")] == 75.0 and m[("swap_percent", "")] == 25.0
    assert m[("memory_available_bytes", "")] == 2000000 * 1024
    load = col.parse_loadavg("0.50 1.25 2.00 3/456 12345\n")
    assert ("load5", "", 1.25) in load and ("procs_running", "", 3.0) in load


def test_network_disk_and_mount_parsers():
    rates = dict(((n, i), v) for n, i, v in col.net_rates(col.parse_net_dev(NETDEV), col.parse_net_dev(NETDEV2), 10))
    assert rates[("net_rx_bytes_ps", "eth0")] == 1000.0 and rates[("net_tx_bytes_ps", "eth0")] == 200.0
    assert rates[("net_rx_errors_ps", "eth0")] == 0.2 and ("net_rx_bytes_ps", "lo") not in rates
    io = dict(((n, i), v) for n, i, v in col.disk_io_rates(col.parse_diskstats(DISKSTATS),
                                                           col.parse_diskstats(DISKSTATS2), 10))
    assert io[("disk_read_iops", "sda")] == 10.0 and io[("disk_write_bytes_ps", "sda")] == 4000 * 512 / 10
    assert "loop0" not in col.parse_diskstats(DISKSTATS)
    assert [m[1] for m in col.parse_mounts(MOUNTS)] == ["/", "/var/lib/data"]
    # counter reset (reboot) → no negative rates
    assert col.net_rates(col.parse_net_dev(NETDEV2), col.parse_net_dev(NETDEV), 10) == []


def test_linux_collector_on_fake_proc(tmp_path):
    proc = tmp_path / "proc"
    (proc / "net").mkdir(parents=True)
    (proc / "sys/kernel").mkdir(parents=True)
    (proc / "123").mkdir()
    (proc / "124").mkdir()
    files = {"stat": STAT1, "meminfo": MEMINFO, "loadavg": "0.1 0.2 0.3 1/100 1\n", "uptime": "3600.5 100\n",
             "diskstats": DISKSTATS, "net/dev": NETDEV, "mounts": "", "net/tcp": "hdr\na\nb\n", "net/tcp6": "hdr\n",
             "sys/kernel/osrelease": "6.8.0\n"}
    for k, v in files.items():
        (proc / k).write_text(v)
    c = col.LinuxCollector(services=["nginx", "bad;rm -rf /"], proc=str(proc), sys=str(tmp_path / "sys"))
    assert c.services == ["nginx"]  # unsafe unit names are discarded
    c.service_states = lambda: [("service_up", "nginx", 1.0)]  # type: ignore[method-assign]
    first = dict(((n, i), v) for n, i, v in c.collect())
    assert ("cpu_percent", "") not in first and first[("process_count", "")] == 2 and first[("tcp_connections", "")] == 2
    (proc / "stat").write_text(STAT2)
    (proc / "net/dev").write_text(NETDEV2)
    second = dict(((n, i), v) for n, i, v in c.collect())
    assert second[("cpu_percent", "")] == 50.0 and ("net_rx_bytes_ps", "eth0") in second
    assert c.system_info()["kernel"] == "6.8.0"


def test_init_system_detection(tmp_path):
    sd = tmp_path / "run_systemd"
    sd.mkdir()
    assert col.detect_init_system(which=lambda _: None, systemd_run=str(sd)) == "systemd"
    assert col.detect_init_system(which=lambda n: "/sbin/rc-service" if n == "rc-service" else None,
                                  systemd_run=str(tmp_path / "nope")) == "openrc"
    initd = tmp_path / "initd"
    initd.mkdir()
    (initd / "nginx").write_text("#!/bin/sh\n")
    assert col.detect_init_system(which=lambda _: None, systemd_run=str(tmp_path / "nope"),
                                  initd=str(initd)) == "sysvinit"
    assert col.detect_init_system(which=lambda _: None, systemd_run=str(tmp_path / "nope"),
                                  initd=str(tmp_path / "missing")) == "unknown"


def test_service_status_parsers():
    assert col.service_up_systemd(0, "active\n", "") is True
    assert col.service_up_systemd(3, "inactive\n", "") is False
    assert col.service_up_openrc(0, " * status: started\n", "") is True
    assert col.service_up_openrc(3, " * status: stopped\n", "") is False
    assert col.service_up_openrc(0, "", "") is True  # exit 0 with no recognisable text
    assert col.service_up_sysvinit(0, "nginx is running\n", "") is True
    assert col.service_up_sysvinit(3, "nginx is not running\n", "") is False
    assert col.service_up_sysvinit(0, "", "") is True


def test_service_states_uses_detected_init(monkeypatch):
    c = col.LinuxCollector(services=["nginx", "ssh"])
    c._init = "openrc"  # pin the init system instead of probing the test host
    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        started = argv[1] == "nginx"
        return col.subprocess.CompletedProcess(argv, 0 if started else 3,
                                               "status: started" if started else "status: stopped", "")

    monkeypatch.setattr(col.subprocess, "run", fake_run)
    states = dict(((n, i), v) for n, i, v in c.service_states())
    assert states[("service_up", "nginx")] == 1.0 and states[("service_up", "ssh")] == 0.0
    assert calls[0][0] == "rc-service"  # OpenRC path, not systemctl


def test_service_states_unknown_init_emits_nothing():
    c = col.LinuxCollector(services=["nginx"])
    c._init = "unknown"
    assert c.service_states() == []


def test_spool_is_bounded(tmp_path):
    s = Spool(tmp_path / "spool", max_files=3)
    for i in range(5):
        s.push("metrics", {"n": i})
    items = s.peek(10)
    assert [p["n"] for _, _, p in items] == [2, 3, 4] and s.dropped == 2
    s.ack(items[0][0])
    assert s.depth() == 2


def test_log_tailer_handles_rotation_and_partial_lines(tmp_path):
    f = tmp_path / "app.log"
    f.write_text("old line\n")
    t = LogTailer([{"path": str(f), "application": "app"}], tmp_path / "state.json")
    assert t.poll() == []  # starts at end of existing file
    with open(f, "a") as fh:
        fh.write("ERROR something broke\npartial")
    recs = t.poll()
    assert len(recs) == 1 and recs[0]["severity"] == "error" and recs[0]["application"] == "app"
    with open(f, "a") as fh:
        fh.write(" line done\n")
    assert t.poll()[0]["message"] == "partial line done"
    t.save()
    os.replace(f, tmp_path / "app.log.1")
    f.write_text("WARN after rotation\n")
    t2 = LogTailer([{"path": str(f)}], tmp_path / "state.json")
    recs = t2.poll()
    assert [r["message"] for r in recs] == ["WARN after rotation"] and recs[0]["severity"] == "warning"


def test_json_log_records_and_severity():
    r = to_record(json.dumps({"msg": "done", "level": "warn", "trace_id": "t1", "user": "bob"}),
                  {"path": "/x", "format": "json"})
    assert r["severity"] == "warning" and r["trace_id"] == "t1" and r["attributes"] == {"user": "bob"}
    assert guess_severity("2026-01-01 [CRIT] disk") == "critical"


def test_backoff_bounds():
    assert all(0 <= backoff_delay(a) <= 300 for a in range(20))


class Handler(BaseHTTPRequestHandler):
    responses: list[tuple[int, dict, dict]] = []
    received: list[tuple[str, dict, dict]] = []

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Handler.received.append((self.path, dict(self.headers), body))
        status, payload, headers = Handler.responses.pop(0) if Handler.responses else (202, {}, {})
        data = json.dumps(payload).encode()
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture
def server():
    Handler.responses, Handler.received = [], []
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


class FakeCollector:
    def collect(self):
        return [("cpu_percent", "", 12.0)]

    def system_info(self):
        return {"cpu_count": 2}


def make_agent(tmp_path, server_url) -> Agent:
    creds = tmp_path / "creds.json"
    write_credentials(str(creds), {"agent_id": "a1", "agent_secret": "s1", "enrolled_at": "2099-01-01T00:00:00+00:00"})
    cfg = Config(server_url=server_url, credentials_file=str(creds), state_dir=str(tmp_path / "state"),
                 allow_insecure_http=True, rotate_credentials_days=0)
    return Agent(cfg, collector=FakeCollector())


def test_transport_requires_https():
    with pytest.raises(ValueError):
        Transport("http://example.com")


def test_delivery_spools_on_backpressure_and_flushes_later(tmp_path, server):
    agent = make_agent(tmp_path, server)
    Handler.responses = [(503, {"error": {"message": "saturated"}}, {"Retry-After": "0"})]
    agent.cycle()
    assert agent.spool.depth() == 1 and agent.failures == 1
    path, headers, body = Handler.received[0]
    assert path == "/api/v1/agents/metrics" and headers["Authorization"] == "Agent a1.s1"
    assert body["samples"][0]["metrics"] == [{"m": "cpu_percent", "i": "", "v": 12.0}]
    Handler.responses = [(202, {"collection_interval_seconds": 15}, {}), (202, {"collection_interval_seconds": 15}, {})]
    agent.next_flush_at = 0
    agent.cycle()
    assert agent.spool.depth() == 0 and agent.failures == 0 and agent.interval == 15
    assert len(Handler.received) == 3


def test_auth_failure_backs_off_long(tmp_path, server):
    agent = make_agent(tmp_path, server)
    Handler.responses = [(401, {"error": {"message": "Agent revoked"}}, {})]
    agent.cycle()
    import time

    assert agent.next_flush_at - time.monotonic() > 250 and "revoked" in agent.last_error


def test_invalid_payload_is_dropped_not_retried(tmp_path, server):
    agent = make_agent(tmp_path, server)
    Handler.responses = [(422, {"error": {"message": "bad"}}, {})]
    agent.cycle()
    assert agent.spool.depth() == 0


def test_transport_error_details(server):
    Handler.responses = [(429, {"error": {"message": "slow down"}}, {"Retry-After": "7"})]
    with pytest.raises(TransportError) as e:
        Transport(server, allow_insecure_http=True).post("/x", {})
    assert e.value.status == 429 and e.value.retry_after == 7.0 and "slow down" in str(e.value)
