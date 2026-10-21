# Load testing

Tool: `backend/scripts/loadtest.py`. It enrolls N agents with one multi-use token, has each push one metric
batch every `--interval` seconds, runs `--readers` concurrent dashboard/list readers, and prints throughput and
latency percentiles.

```bash
python scripts/loadtest.py --base https://monitor.example.com --email admin@example.com --password '...' \
   --org-slug acme --agents 500 --duration 300 --interval 10 --metrics-per-sample 40 --readers 5
```
Raise `EMONITOR_RATE_LIMIT_ENROLL` temporarily for large runs, and delete the `loadtest-*` servers afterwards.
**Always record hardware, topology and configuration with results.** Do not quote capacity numbers that
were not measured on comparable hardware.

## Recorded runs

### 2026-10-21 — developer laptop, API request path only (NOT a production deployment)
* Hardware: Intel Core i5-7200U (2 cores / 4 threads, 2.5 GHz), 7.8 GB RAM, Windows 11, PostgreSQL 17.6
  (local, default config), Redis protocol served by fakeredis (in-process Python), **one** uvicorn worker,
  load generator on the same machine.
* Mode: production request path (API validates and writes batches to the Redis ingest stream). No ClickHouse
  consumer and no Celery workers were running — the run measures API/agent-endpoint capacity only.
* Load: 100 agents × 1 batch / 5 s × 40 metrics + 4 continuous readers, 60 s.

| Result | Value |
|---|---|
| Ingest requests | 1,089 (16.7/s), all HTTP 202 |
| Metric points accepted | 43,560 (≈668/s) |
| Ingest latency | p50 238 ms · p95 1,704 ms · p99 2,390 ms |
| Reads (dashboard/lists) | 397 (6.1/s), all 200, p50 159 ms · p95 2,439 ms |

A second run with development "inline workers" (thresholds evaluated inside each request on the same
2-core CPU) accepted 925/927 batches with p50 1.85 s — that mode is for development only.

Interpretation: on this hardware a single API worker sustained the offered 20 req/s with tail latency driven
by CPU contention between server, readers and load generator. Production deployments run 4+ uvicorn workers
behind nginx, real Redis, a separate ingest consumer and Celery workers, on dedicated hosts — **this run does not
establish production capacity**. Issues found and fixed during these runs: DB-connection pool exhaustion when
Redis was slow (rate limiting now happens before DB access; Redis has socket timeouts), per-agent queries in the
liveness sweep (now one set-based query), Argon2 hashing on the event loop (now in a thread), and a nested
session in the development ingest path.

## Not yet measured (to do on Ubuntu staging hardware)
* ClickHouse ingest throughput through `emonitor-ingest` (batch size 5,000 / 1 s flush).
* Check throughput per Celery worker (`emonitor-worker@checks`, concurrency 8) for HTTP/ICMP mixes.
* Log search latency at 10⁸+ rows with the token bloom filter index.
