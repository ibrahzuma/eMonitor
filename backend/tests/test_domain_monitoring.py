"""Domain registration expiry (RDAP/WHOIS parsing, thresholds) and website DNS/domain coverage."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.models.enums import CheckOutcomeStatus
from app.monitoring.check_configs import DomainConfig
from app.monitoring.netguard import Scope
from app.monitoring.probes import ProbeContext
from app.monitoring.probes import domain as dom
from tests.conftest import make_actor, make_org
from tests.helpers import T0, feed, incidents, make_check

API = "/api/v1"

TZ_WHOIS = """% Whoisd Server Version: 3.15.0
domain:       qalaam.co.tz
registrar:    REG-ROUTEAFRICA
registered:   27.02.2026 16:30:37
expire:       27.02.2027

nsset:        2E769A1724BC0699
nserver:      ns1.linode.com
nserver:      ns2.linode.com
"""
COM_WHOIS = """   Domain Name: EXAMPLE.COM
   Registrar: RESERVED-Internet Assigned Numbers Authority
   Registry Expiry Date: 2027-08-13T04:00:00Z
   Name Server: A.IANA-SERVERS.NET
   Name Server: B.IANA-SERVERS.NET
"""


@pytest.mark.parametrize("host,expected", [
    ("www.qalaam.co.tz", "qalaam.co.tz"), ("qalaam.co.tz", "qalaam.co.tz"), ("api.github.com", "github.com"),
    ("example.com", "example.com"), ("shop.bbc.co.uk", "bbc.co.uk"), ("a.b.example.de", "example.de"),
])
def test_registrable_domain(host, expected):
    assert dom.registrable_domain(host) == expected


def test_parse_whois_formats():
    tz = dom.parse_whois(TZ_WHOIS)
    assert tz["expires_at"] == datetime(2027, 2, 27, tzinfo=UTC)
    assert tz["registrar"] == "REG-ROUTEAFRICA" and tz["nameservers"] == ["ns1.linode.com", "ns2.linode.com"]
    com = dom.parse_whois(COM_WHOIS)
    assert com["expires_at"] == datetime(2027, 8, 13, 4, tzinfo=UTC)
    assert com["nameservers"] == ["a.iana-servers.net", "b.iana-servers.net"]


def test_parse_rdap():
    doc = {"events": [{"eventAction": "registration", "eventDate": "2007-10-09T18:20:50Z"},
                      {"eventAction": "expiration", "eventDate": "2028-10-09T18:20:50Z"}],
           "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["version", {}, "text", "4.0"],
                                                                         ["fn", {}, "text", "MarkMonitor Inc."]]]}],
           "nameservers": [{"ldhName": "NS1.EXAMPLE.NET"}], "status": ["client transfer prohibited"]}
    info = dom.parse_rdap(doc)
    assert info["expires_at"].year == 2028 and info["registrar"] == "MarkMonitor Inc."
    assert info["nameservers"] == ["ns1.example.net"]


def test_domain_config_validation():
    assert DomainConfig(domain="HTTPS://Qalaam.co.tz/").domain == "qalaam.co.tz"
    with pytest.raises(ValueError):
        DomainConfig(domain="not a domain")


async def test_probe_maps_lookup_results(monkeypatch):
    ctx = ProbeContext(scope=Scope(), timeout=10)
    cfg = DomainConfig(domain="example.com")

    async def ok(domain, timeout):
        return {"expires_at": datetime.now(UTC) + timedelta(days=40, hours=1), "registrar": "R"}, "rdap", []

    monkeypatch.setattr(dom, "lookup", ok)
    r = await dom.probe_domain(cfg, ctx)
    assert r.status == CheckOutcomeStatus.UP and r.details["domain"]["days_remaining"] == 40

    async def expired(domain, timeout):
        return {"expires_at": datetime.now(UTC) - timedelta(days=2)}, "whois:x", []

    monkeypatch.setattr(dom, "lookup", expired)
    assert (await dom.probe_domain(cfg, ctx)).status == CheckOutcomeStatus.DOWN

    async def unknown(domain, timeout):
        return {}, "", ["no RDAP service", "WHOIS error: TimeoutError"]

    monkeypatch.setattr(dom, "lookup", unknown)
    r = await dom.probe_domain(cfg, ctx)
    assert r.status == CheckOutcomeStatus.UNKNOWN and "could not determine" in r.message


async def test_domain_expiry_thresholds_raise_escalate_and_clear():
    org = await make_org()
    _, c = await make_check(org, kind="website", check_type="domain", config={"domain": "example.com"},
                            interval=43200, failure_threshold=1)

    def d(days):
        return {"domain": {"name": "example.com", "days_remaining": days, "expires_at": "x", "registrar": "R",
                           "expired": False}}

    await feed(c, ["up"], details=d(90))
    assert await incidents(org.id) == []
    await feed(c, ["up"], start=T0 + timedelta(days=1), details=d(45))
    incs = await incidents(org.id)
    assert len(incs) == 1 and incs[0].severity == "warning" and incs[0].dedup_key == f"domain:{c.id}"
    await feed(c, ["up"], start=T0 + timedelta(days=2), details=d(5))
    incs = await incidents(org.id)
    assert len(incs) == 1 and incs[0].severity == "critical" and incs[0].evidence["renotify_marker"] == "domain:7"
    await feed(c, ["up"], start=T0 + timedelta(days=3), details=d(400))
    assert (await incidents(org.id))[0].status == "resolved"


async def test_website_creates_dns_and_domain_checks(client):
    a = await make_actor(client)
    r = await client.post(f"{API}/websites", headers=a.headers, json={"name": "Qalaam", "url": "https://www.qalaam.co.tz/"})
    assert r.status_code == 201, r.text
    checks = {c["type"]: c for c in r.json()["checks"]}
    assert set(checks) == {"http", "dns", "domain"}
    assert checks["dns"]["config"]["name"] == "www.qalaam.co.tz" and checks["dns"]["config"]["record_type"] == "A"
    assert checks["domain"]["config"]["domain"] == "qalaam.co.tz" and checks["domain"]["interval_seconds"] == 43200
    only_http = await client.post(f"{API}/websites", headers=a.headers, json={
        "name": "Plain", "url": "https://example.com/", "monitor_dns": False, "monitor_domain": False})
    assert [c["type"] for c in only_http.json()["checks"]] == ["http"]
    custom = await client.post(f"{API}/websites", headers=a.headers, json={
        "name": "Custom", "url": "https://app.example.org/", "domain": "example.org", "domain_alert_days": [30, 7]})
    dchk = next(c for c in custom.json()["checks"] if c["type"] == "domain")
    assert dchk["config"] == {"domain": "example.org", "alert_days": [30, 7]}
    rep = await client.get(f"{API}/reports/domains", headers=a.headers)
    assert rep.status_code == 200 and len(rep.json()["rows"]) == 2


@pytest.mark.network
async def test_live_lookup_qalaam():
    """Live registry lookup (skipped offline): .tz uses WHOIS, .com uses RDAP."""
    try:
        info, source, errors = await dom.lookup("qalaam.co.tz", 20)
    except Exception as exc:  # pragma: no cover - network dependent
        pytest.skip(f"network unavailable: {exc}")
    if not info.get("expires_at"):
        pytest.skip(f"registry lookup unavailable: {errors}")
    assert info["expires_at"].year >= 2027
