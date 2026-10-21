import type { MaintenanceWindow, MaintenanceWindowIn, Recurrence } from "@/types/api";
import { getDisplayTimeZone, isoToLocalInput, localInputToIso } from "@/utils/format";

export type RecurrenceFreq = "none" | Recurrence["freq"];
export type RecurrenceEnd = "never" | "until" | "count";

export interface WindowForm {
  name: string;
  reason: string;
  starts_local: string;
  ends_local: string;
  timezone: string;
  freq: RecurrenceFreq;
  interval: string;
  byweekday: number[];
  end_mode: RecurrenceEnd;
  until_local: string;
  count: string;
  scope: MaintenanceWindowIn["scope"];
  resource_ids: string[];
  group_ids: string[];
  suppress_notifications: boolean;
  suppress_incidents: boolean;
  responsible_user_id: string;
  is_active: boolean;
}

export function emptyWindowForm(now: Date = new Date(), tz: string = getDisplayTimeZone()): WindowForm {
  const start = new Date(Math.ceil(now.getTime() / 3600000) * 3600000);
  const end = new Date(start.getTime() + 2 * 3600000);
  return {
    name: "",
    reason: "",
    starts_local: isoToLocalInput(start.toISOString(), tz),
    ends_local: isoToLocalInput(end.toISOString(), tz),
    timezone: tz,
    freq: "none",
    interval: "1",
    byweekday: [],
    end_mode: "never",
    until_local: "",
    count: "",
    scope: "resources",
    resource_ids: [],
    group_ids: [],
    suppress_notifications: true,
    suppress_incidents: false,
    responsible_user_id: "",
    is_active: true,
  };
}

export function windowToForm(w: MaintenanceWindow): WindowForm {
  const tz = w.timezone || "UTC";
  const r = w.recurrence;
  return {
    name: w.name,
    reason: w.reason,
    starts_local: isoToLocalInput(w.starts_at, tz),
    ends_local: isoToLocalInput(w.ends_at, tz),
    timezone: tz,
    freq: r?.freq ?? "none",
    interval: String(r?.interval ?? 1),
    byweekday: r?.byweekday ?? [],
    end_mode: r?.until ? "until" : r?.count ? "count" : "never",
    until_local: r?.until ? isoToLocalInput(r.until, tz) : "",
    count: r?.count ? String(r.count) : "",
    scope: (w.scope as WindowForm["scope"]) ?? "resources",
    resource_ids: w.resource_ids ?? [],
    group_ids: w.group_ids ?? [],
    suppress_notifications: w.suppress_notifications,
    suppress_incidents: w.suppress_incidents,
    responsible_user_id: w.responsible_user_id ?? "",
    is_active: w.is_active,
  };
}

/** Validate the form and build the API payload. Datetimes are wall-clock times in the window's time zone. */
export function windowPayload(f: WindowForm): { payload: MaintenanceWindowIn | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = "Name is required";
  const starts = localInputToIso(f.starts_local, f.timezone);
  const ends = localInputToIso(f.ends_local, f.timezone);
  if (!starts) errors.starts_at = "Start is required";
  if (!ends) errors.ends_at = "End is required";
  if (starts && ends && new Date(ends) <= new Date(starts)) errors.ends_at = "End must be after start";
  let recurrence: Recurrence | null = null;
  if (f.freq !== "none") {
    const interval = Number(f.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 52) errors.interval = "Interval must be 1–52";
    if (starts && ends && new Date(ends).getTime() - new Date(starts).getTime() > 31 * 86400000) {
      errors.ends_at = "Recurring windows may last at most 31 days per occurrence";
    }
    let until: string | null = null;
    let count: number | null = null;
    if (f.end_mode === "until") {
      until = localInputToIso(f.until_local, f.timezone);
      if (!until) errors.until = "Choose an end date";
    } else if (f.end_mode === "count") {
      count = Number(f.count);
      if (!Number.isInteger(count) || count < 1 || count > 1000) errors.count = "Occurrences must be 1–1000";
    }
    recurrence = {
      freq: f.freq,
      interval,
      byweekday: f.freq === "weekly" ? [...new Set(f.byweekday)].sort((a, b) => a - b) : [],
      until,
      count,
    };
  }
  if (f.scope === "resources" && !f.resource_ids.length) errors.resource_ids = "Select at least one resource";
  if (f.scope === "groups" && !f.group_ids.length) errors.group_ids = "Select at least one group";
  if (Object.keys(errors).length || !starts || !ends) return { payload: null, errors };
  return {
    payload: {
      name: f.name.trim(),
      reason: f.reason,
      starts_at: starts,
      ends_at: ends,
      timezone: f.timezone,
      recurrence,
      scope: f.scope,
      resource_ids: f.scope === "resources" ? f.resource_ids : [],
      group_ids: f.scope === "groups" ? f.group_ids : [],
      suppress_notifications: f.suppress_notifications,
      suppress_incidents: f.suppress_incidents,
      responsible_user_id: f.responsible_user_id || null,
      is_active: f.is_active,
    },
    errors,
  };
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function recurrenceSummary(r: Recurrence | null | undefined): string {
  if (!r) return "One-time";
  const unit = { daily: "day", weekly: "week", monthly: "month" }[r.freq];
  let s = r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`;
  if (r.freq === "weekly" && r.byweekday?.length) s += ` on ${r.byweekday.map((d) => DAY_NAMES[d]).join(", ")}`;
  if (r.count) s += `, ${r.count} times`;
  return s;
}
