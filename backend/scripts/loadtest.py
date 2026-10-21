"""Load test for agent telemetry ingestion and dashboard/API reads.

Simulates N enrolled agents pushing metric batches concurrently, plus readers hitting
dashboard/list endpoints, and reports throughput and latency percentiles.

    python scripts/loadtest.py --base http://127.0.0.1:8000 --email admin@example.com --password ... \
        --org-slug acme --agents 200 --duration 60 --metrics-per-sample 40 --readers 5

Agents are enrolled with one multi-use enrollment token (created through the API) and appear as
servers named loadtest-<n> in the selected organization. Delete them afterwards via the UI/API.
Results depend entirely on hardware and deployment topology — record both with every run
(see docs/LOAD_TESTING.md).
"""

from __future__ import annotations

import argparse
import asyncio
import random
import statistics
import time
from datetime import UTC, datetime

import httpx


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    return s[min(len(s) - 1, int(len(s) * p))]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--org-slug", required=True)
    ap.add_argument("--agents", type=int, default=50)
    ap.add_argument("--duration", type=int, default=30)
    ap.add_argument("--interval", type=float, default=10.0, help="seconds between pushes per agent")
    ap.add_argument("--metrics-per-sample", type=int, default=40)
    ap.add_argument("--readers", type=int, default=2)
    a = ap.parse_args()
    api = a.base.rstrip("/") + "/api/v1"
    limits = httpx.Limits(max_connections=500, max_keepalive_connections=200)
    async with httpx.AsyncClient(timeout=30, limits=limits) as c:
        tok = (await c.post(f"{api}/auth/login", json={"email": a.email, "password": a.password})).json()["access_token"]
        h = {"Authorization": f"Bearer {tok}"}
        me = (await c.get(f"{api}/auth/me", headers=h)).json()
        org = next(m["organization_id"] for m in me["memberships"] if m["organization_slug"] == a.org_slug)
        h["X-Organization-ID"] = org
        et = (await c.post(f"{api}/agents/enrollment-tokens", headers=h,
                           json={"description": "loadtest", "max_uses": a.agents, "tags": ["loadtest"]})).json()["token"]
        print(f"enrolling {a.agents} agents ...")
        creds = []
        for i in range(a.agents):
            r = await c.post(f"{api}/agents/enroll", json={"token": et, "hostname": f"loadtest-{i}", "cpu_count": 4})
            if r.status_code == 429:
                raise SystemExit("enrollment rate limited; raise EMONITOR_RATE_LIMIT_ENROLL for the test")
            r.raise_for_status()
            creds.append(r.json())

        lat: list[float] = []
        read_lat: list[float] = []
        codes: dict[int, int] = {}
        read_codes: dict[int, int] = {}
        points = 0
        stop_at = time.monotonic() + a.duration

        async def agent(cr: dict) -> None:
            nonlocal points
            auth = {"Authorization": f"Agent {cr['agent_id']}.{cr['agent_secret']}"}
            await asyncio.sleep(random.uniform(0, a.interval))
            while time.monotonic() < stop_at:
                ms = [{"m": "cpu_percent", "v": random.uniform(1, 60)}, {"m": "memory_percent", "v": random.uniform(20, 70)}]
                ms += [{"m": "disk_percent", "i": f"/mnt/{k}", "v": random.uniform(10, 70)}
                       for k in range(max(0, a.metrics_per_sample - 2))]
                body = {"agent_version": "loadtest", "samples": [{"ts": datetime.now(UTC).isoformat(), "metrics": ms}]}
                t0 = time.perf_counter()
                try:
                    r = await c.post(f"{api}/agents/metrics", json=body, headers=auth)
                    codes[r.status_code] = codes.get(r.status_code, 0) + 1
                    if r.status_code == 202:
                        points += len(ms)
                except httpx.HTTPError:
                    codes[-1] = codes.get(-1, 0) + 1
                lat.append((time.perf_counter() - t0) * 1000)
                await asyncio.sleep(a.interval)

        async def reader() -> None:
            paths = ["/dashboard/summary", "/servers?page_size=50", "/incidents?open=true", "/dashboard/trends?range=24h"]
            while time.monotonic() < stop_at:
                t0 = time.perf_counter()
                try:
                    r = await c.get(api + random.choice(paths), headers=h)
                    read_codes[r.status_code] = read_codes.get(r.status_code, 0) + 1
                except httpx.HTTPError:
                    read_codes[-1] = read_codes.get(-1, 0) + 1
                read_lat.append((time.perf_counter() - t0) * 1000)

        t_start = time.monotonic()
        await asyncio.gather(*(agent(cr) for cr in creds), *(reader() for _ in range(a.readers)))
        elapsed = time.monotonic() - t_start
    print(f"\nduration {elapsed:.1f}s, agents {a.agents}, interval {a.interval}s, metrics/sample {a.metrics_per_sample}")
    print(f"ingest requests: {len(lat)} ({len(lat) / elapsed:.1f}/s), status codes {codes}")
    print(f"metric points accepted: {points} ({points / elapsed:.0f}/s)")
    print(f"ingest latency ms: p50 {pct(lat, .5):.1f}  p95 {pct(lat, .95):.1f}  p99 {pct(lat, .99):.1f}  "
          f"mean {statistics.fmean(lat) if lat else float('nan'):.1f}")
    print(f"read requests: {len(read_lat)} ({len(read_lat) / elapsed:.1f}/s), latency ms p50 {pct(read_lat, .5):.1f} "
          f"p95 {pct(read_lat, .95):.1f}, status codes {read_codes}")


if __name__ == "__main__":
    asyncio.run(main())
