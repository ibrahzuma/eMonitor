from __future__ import annotations

from datetime import UTC, datetime

from app.core.db import get_sessionmaker
from app.models import Resource, ServerDetail
from app.workers.syslog_collector import Collector, parse_syslog
from tests.conftest import make_org

NOW = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)


def test_parse_rfc5424():
    p = parse_syslog('<165>1 2026-05-01T11:59:58.123Z fw01 sshd 4242 ID47 [exampleSDID@32473 iut="3"] Failed password',
                     NOW)
    assert p["severity"] == "notice" and p["facility"] == 20 and p["host"] == "fw01" and p["application"] == "sshd"
    assert p["message"] == "Failed password" and p["ts"].minute == 59 and p["attributes"]["msgid"] == "ID47"


def test_parse_rfc3164_and_fallbacks():
    p = parse_syslog("<11>May  1 11:58:00 router1 kernel[12]: link down on eth3", NOW)
    assert p["severity"] == "error" and p["host"] == "router1" and p["application"] == "kernel"
    assert p["message"] == "link down on eth3" and p["attributes"]["procid"] == "12"
    assert parse_syslog("<12>just text", NOW)["severity"] == "warning"
    assert parse_syslog("no pri at all", NOW)["message"] == "no pri at all"


async def test_only_registered_sources_accepted():
    org = await make_org()
    async with get_sessionmaker()() as s:
        r = Resource(organization_id=org.id, kind="server", name="srv")
        d = Resource(organization_id=org.id, kind="network_device", name="fw",
                     attributes={"syslog_sources": ["10.9.9.9"]})
        s.add_all([r, d])
        await s.flush()
        s.add(ServerDetail(resource_id=r.id, organization_id=org.id, ip_address="10.1.1.1"))
        await s.commit()
    c = Collector()
    await c.refresh_sources()
    c.offer("10.1.1.1", "<14>May  1 11:58:00 srv app: hello")
    c.offer("10.9.9.9", "<10>May  1 11:58:00 fw ids: alert")
    c.offer("6.6.6.6", "<10>spoofed")
    assert c.queue.qsize() == 2 and c.dropped_unknown == 1
    row = c.to_row(*c.queue.get_nowait())
    assert row["org_id"] == org.id and row["resource_id"] == r.id and row["source"] == "syslog"
