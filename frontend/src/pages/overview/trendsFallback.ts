/**
 * Client-side computation of dashboard trends, used when GET /dashboard/trends fails
 * (backend bug: the `range` query parameter shadows Python's builtin range()).
 */
import type { CheckBucket, DashboardTrends, Incident, Severity } from "@/types/api";

export function trendBucketSeconds(rangeSeconds: number): number {
  return rangeSeconds > 2 * 86400 ? 86400 : 3600;
}

/** Bucket incidents by first_detected_at, stacked by severity, covering [start, end]. */
export function incidentTrend(incidents: Pick<Incident, "first_detected_at" | "severity">[], start: Date, end: Date,
  bucketSeconds: number): DashboardTrends["incidents"] {
  const b = bucketSeconds * 1000;
  const first = Math.floor(start.getTime() / b) * b;
  const counts = new Map<number, Record<Severity, number>>();
  for (let t = first; t <= end.getTime(); t += b) counts.set(t, { critical: 0, high: 0, warning: 0, info: 0 });
  for (const i of incidents) {
    const ts = new Date(i.first_detected_at).getTime();
    if (Number.isNaN(ts) || ts < start.getTime() || ts >= end.getTime()) continue;
    const key = Math.floor(ts / b) * b;
    const row = counts.get(key);
    if (!row) continue;
    const sev = (["critical", "high", "warning", "info"] as const).includes(i.severity) ? i.severity : "info";
    row[sev] += 1;
  }
  return [...counts.entries()].sort((a, c) => a[0] - c[0]).map(([t, r]) => ({ ts: new Date(t).toISOString(), ...r }));
}

/** Merge per-check bucket series into an aggregated availability trend. */
export function mergeAvailability(series: CheckBucket[][]): DashboardTrends["availability"] {
  const map = new Map<number, { up: number; degraded: number; down: number; unknown: number; latSum: number; latN: number }>();
  for (const s of series) {
    for (const p of s) {
      const t = new Date(p.bucket).getTime();
      if (Number.isNaN(t)) continue;
      const row = map.get(t) ?? { up: 0, degraded: 0, down: 0, unknown: 0, latSum: 0, latN: 0 };
      row.up += p.up;
      row.degraded += p.degraded;
      row.down += p.down;
      row.unknown += p.unknown;
      if (p.avg_ms !== null && p.avg_ms !== undefined) {
        const n = p.up + p.degraded || 1;
        row.latSum += p.avg_ms * n;
        row.latN += n;
      }
      map.set(t, row);
    }
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => {
    const known = r.up + r.degraded + r.down;
    return {
      ts: new Date(t).toISOString(),
      uptime_percent: known ? Math.round(((r.up + r.degraded) / known) * 100000) / 1000 : null,
      down: r.down,
      unknown: r.unknown,
      avg_ms: r.latN ? r.latSum / r.latN : null,
    };
  });
}
