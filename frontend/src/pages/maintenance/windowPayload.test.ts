import { describe, expect, it } from "vitest";
import type { MaintenanceWindow } from "@/types/api";
import { emptyWindowForm, recurrenceSummary, windowPayload, windowToForm } from "@/pages/maintenance/windowPayload";

const base = () => ({ ...emptyWindowForm(new Date("2026-10-21T06:30:00Z"), "UTC"), name: "DB upgrade", resource_ids: ["r1"] });

describe("maintenance window payload", () => {
  it("interprets start/end as wall-clock time in the window's time zone", () => {
    const { payload, errors } = windowPayload({
      ...base(), timezone: "Europe/Berlin", starts_local: "2026-07-01T22:00", ends_local: "2026-07-02T01:30",
    });
    expect(errors).toEqual({});
    expect(payload?.starts_at).toBe("2026-07-01T20:00:00.000Z"); // CEST = UTC+2
    expect(payload?.ends_at).toBe("2026-07-01T23:30:00.000Z");
    expect(payload?.timezone).toBe("Europe/Berlin");
    expect(payload?.recurrence).toBeNull();
    expect(payload?.resource_ids).toEqual(["r1"]);
  });

  it("builds a weekly recurrence with sorted weekdays and an occurrence count", () => {
    const { payload } = windowPayload({
      ...base(), starts_local: "2026-11-01T02:00", ends_local: "2026-11-01T04:00", freq: "weekly", interval: "2",
      byweekday: [5, 1, 5], end_mode: "count", count: "10",
    });
    expect(payload?.recurrence).toEqual({ freq: "weekly", interval: 2, byweekday: [1, 5], until: null, count: 10 });
    expect(recurrenceSummary(payload?.recurrence)).toBe("Every 2 weeks on Tue, Sat, 10 times");
  });

  it("converts the recurrence end date in the window time zone", () => {
    const { payload } = windowPayload({
      ...base(), timezone: "America/New_York", starts_local: "2026-11-01T02:00", ends_local: "2026-11-01T03:00",
      freq: "daily", end_mode: "until", until_local: "2026-12-01T00:00",
    });
    expect(payload?.recurrence?.until).toBe("2026-12-01T05:00:00.000Z"); // EST = UTC-5
    expect(payload?.recurrence?.byweekday).toEqual([]);
  });

  it("validates ordering, scope and recurrence limits", () => {
    const { payload, errors } = windowPayload({
      ...base(), name: "", resource_ids: [], starts_local: "2026-11-01T05:00", ends_local: "2026-11-01T04:00",
    });
    expect(payload).toBeNull();
    expect(errors.name).toBeDefined();
    expect(errors.ends_at).toMatch(/after start/);
    expect(errors.resource_ids).toBeDefined();
    const long = windowPayload({ ...base(), starts_local: "2026-11-01T00:00", ends_local: "2026-12-15T00:00", freq: "monthly" });
    expect(long.errors.ends_at).toMatch(/31 days/);
  });

  it("organization scope sends no resource or group ids", () => {
    const { payload } = windowPayload({ ...base(), scope: "organization", group_ids: ["g1"] });
    expect(payload?.resource_ids).toEqual([]);
    expect(payload?.group_ids).toEqual([]);
  });

  it("round-trips an existing window into the form in its own time zone", () => {
    const w = {
      id: "w1", name: "Patch", reason: "", starts_at: "2026-07-01T20:00:00Z", ends_at: "2026-07-01T22:00:00Z", timezone: "Europe/Berlin",
      recurrence: { freq: "weekly", interval: 1, byweekday: [2], until: null, count: 3 }, scope: "groups", resource_ids: [], group_ids: ["g1"],
      suppress_notifications: true, suppress_incidents: false, responsible_user_id: null, is_active: true, created_by_id: null,
      created_at: "2026-06-01T00:00:00Z", active_now: false, current_occurrence: null, next_occurrence: null, expired: false,
    } as MaintenanceWindow;
    const f = windowToForm(w);
    expect(f.starts_local).toBe("2026-07-01T22:00");
    expect(f.end_mode).toBe("count");
    expect(windowPayload(f).payload?.starts_at).toBe("2026-07-01T20:00:00.000Z");
  });
});
