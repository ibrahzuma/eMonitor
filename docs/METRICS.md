# How eMonitor calculates availability, incidents and SLO metrics

All timestamps are stored in UTC. The UI converts to the user's time zone.

## Check slots
Every check has an interval. The scheduler assigns each execution a **slot** (`scheduled_at`). Each slot ends
up in exactly one state:

| State | Meaning |
|---|---|
| `up` | probe succeeded |
| `degraded` | reachable but violated a soft condition (e.g. slower than `degraded_threshold_ms`) — counts as available |
| `down` | probe failed (HTTP status, keyword, timeout, connection refused, DNS failure, TLS invalid, …) |
| `unknown` | probe could not determine the state (worker error, target blocked by policy, bad config) |
| `skipped` | scheduler could not dispatch the slot in time (outage, backpressure) |
| *(missing)* | no record at all for an expected slot |

Slots during an active maintenance window are stored with `in_maintenance=1`; their real state is kept.

## Availability (uptime)
For a check and period `[start, end)`:

* `expected = floor((end − max(start, check.created_at)) / interval)`
* `known = up + degraded + down` (non-maintenance)
* **`uptime % = (up + degraded) / known × 100`**
* **`coverage % = (known + maintenance) / max(expected, recorded)`**
* `unknown slots = unknown + skipped + (expected − recorded)`
* `downtime ≈ down × interval`

Unknown time is **never** counted as up or down; it lowers coverage instead, so a report with 100 % uptime
and 40 % coverage means "no failures observed, but only 40 % of the period was observed". Maintenance slots
are excluded from uptime; reports list them separately (and any `down` results during maintenance are still
stored and visible in the check history).

Resource availability sums slot counts over the resource's checks (a resource with a failing ping and a
passing HTTP check therefore shows reduced availability). The implementation is
`backend/app/services/availability.py` (`compute_availability`, `combine`), unit-tested in
`tests/test_maintenance_availability.py`.

## Health status
* A check moves to **failing** after `failure_threshold` consecutive `down` results and back to **healthy**
  after `recovery_threshold` consecutive `up/degraded` results. `unknown` never changes state.
* Failing ICMP checks (and TCP/22 on servers) mean **Unreachable**; other failing checks map by severity
  (critical/high → Critical, warning/info → Warning).
* Agent metrics are compared with thresholds (organization defaults, overridable per server); a level change
  needs `metric_consecutive_samples` (default 2) consecutive samples.
* An agent silent for longer than its timeout (default 180 s) marks the server **Unreachable**.
* Resource status = worst of its checks, metric states and agent state; **Maintenance** while a window is
  active; **Unknown** when there is no data or monitoring is paused.

## Incidents
* One open incident per condition (`dedup_key`), enforced by a partial unique index — repeated failures
  increment `occurrence_count` and update `last_detected_at`.
* Recovery auto-resolves (unless the rule disables auto-resolve). A recurrence within
  `reopen_window_minutes` (default 60) reopens the same incident instead of opening a new one.
* SSL: one incident per certificate; it is re-notified at each crossed threshold (default 30/14/7/3/0 days)
  with escalating severity and resolves when the certificate is renewed.

* Domain registration: websites get a **Domain expiry** check (twice a day) that reads the expiry date from the
  registry's RDAP service (IANA bootstrap), falling back to WHOIS. One incident per domain, re-notified at each
  crossed threshold (default 60/30/14/7/1 days; warning → high → critical); an expired or unregistered domain
  makes the check DOWN. If the registry cannot be queried the check is UNKNOWN (never counted as downtime).
* DNS: websites also get a **DNS** check (every 5 minutes) that the hostname still resolves (A/AAAA/CNAME);
  expected answers can be pinned in the check settings to alert on unexpected changes.

## Incident metrics (Reports → Incidents)
* **MTTD** — mean of `incident.first_detected_at − condition_started_at`, where `condition_started_at` is the
  first failing slot. Only check-based incidents carry this value; it reflects `failure_threshold × interval`.
* **MTTA** — mean of `acknowledged_at − first_detected_at` over acknowledged incidents.
* **MTTR** — mean of `resolved_at − first_detected_at` over resolved incidents.
* Incidents are attributed to the period by `first_detected_at`.

## SLOs and error budgets
For an SLO with target `T %` over `W` days:
* SLI = availability over the window (as above, using the SLO's check or all checks of the resource).
* Allowed bad fraction = `1 − T/100`; **error budget remaining** = `1 − bad / (allowed × total)`.
* **Burn rate** over a window = `(bad / total) / (1 − T/100)` — 1.0 consumes the budget exactly at the end
  of the SLO window.
* Multi-window alerting (Google SRE workbook): fast burn = 1 h burn rate ≥ 14.4 (critical), slow burn = 6 h burn
  rate ≥ 6 (warning). Status: `breached` (SLI < target), `at_risk` (burn thresholds hit or < 25 % budget
  left), `ok`, `no_data`. SLOs are evaluated every 5 minutes; burn-rate incidents use dedup key `slo:{id}`.

## Capacity projection
Disk trends use daily averages; growth per day = (last − first) / days; days-until-full is a linear
extrapolation and is labelled as indicative.
