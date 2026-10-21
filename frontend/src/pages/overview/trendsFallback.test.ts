import { describe, expect, it } from "vitest";
import { incidentTrend, mergeAvailability, trendBucketSeconds } from "@/pages/overview/trendsFallback";

describe("trends fallback", () => {
  it("picks hourly buckets up to 2 days and daily beyond", () => {
    expect(trendBucketSeconds(86400)).toBe(3600);
    expect(trendBucketSeconds(7 * 86400)).toBe(86400);
  });

  it("buckets incidents by severity and fills empty buckets", () => {
    const start = new Date("2026-10-21T00:00:00Z");
    const end = new Date("2026-10-21T03:00:00Z");
    const rows = incidentTrend([
      { first_detected_at: "2026-10-21T00:10:00Z", severity: "critical" },
      { first_detected_at: "2026-10-21T00:50:00Z", severity: "critical" },
      { first_detected_at: "2026-10-21T02:05:00Z", severity: "warning" },
      { first_detected_at: "2026-10-20T23:00:00Z", severity: "info" },
    ], start, end, 3600);
    expect(rows.map((r) => r.ts)).toEqual([
      "2026-10-21T00:00:00.000Z", "2026-10-21T01:00:00.000Z", "2026-10-21T02:00:00.000Z", "2026-10-21T03:00:00.000Z",
    ]);
    expect(rows[0]).toMatchObject({ critical: 2, warning: 0, info: 0 });
    expect(rows[1]).toMatchObject({ critical: 0, high: 0, warning: 0, info: 0 });
    expect(rows[2]).toMatchObject({ warning: 1 });
  });

  it("merges check buckets into uptime percentages", () => {
    const rows = mergeAvailability([
      [{ bucket: "2026-10-21T00:00:00Z", up: 9, degraded: 0, down: 1, unknown: 0, maintenance: 0, avg_ms: 100 }],
      [
        { bucket: "2026-10-21T00:00:00Z", up: 10, degraded: 0, down: 0, unknown: 2, maintenance: 0, avg_ms: 200 },
        { bucket: "2026-10-21T01:00:00Z", up: 0, degraded: 0, down: 0, unknown: 3, maintenance: 0, avg_ms: null },
      ],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].uptime_percent).toBe(95);
    expect(rows[0].down).toBe(1);
    expect(rows[0].unknown).toBe(2);
    expect(rows[0].avg_ms).toBeCloseTo((100 * 9 + 200 * 10) / 19);
    expect(rows[1].uptime_percent).toBeNull();
  });
});
