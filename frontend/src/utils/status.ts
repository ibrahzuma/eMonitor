import type { IncidentStatus, Severity } from "@/types/api";

interface StatusStyle {
  dot: string;
  badge: string;
  text: string;
  fill: string;
}

const GREEN: StatusStyle = {
  dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", fill: "#10b981",
  badge: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-300",
};
const AMBER: StatusStyle = {
  dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", fill: "#f59e0b",
  badge: "bg-amber-500/10 text-amber-700 ring-amber-600/20 dark:text-amber-300",
};
const RED: StatusStyle = {
  dot: "bg-red-500", text: "text-red-600 dark:text-red-400", fill: "#ef4444",
  badge: "bg-red-500/10 text-red-700 ring-red-600/20 dark:text-red-300",
};
const PURPLE: StatusStyle = {
  dot: "bg-fuchsia-500", text: "text-fuchsia-600 dark:text-fuchsia-400", fill: "#d946ef",
  badge: "bg-fuchsia-500/10 text-fuchsia-700 ring-fuchsia-600/20 dark:text-fuchsia-300",
};
const GRAY: StatusStyle = {
  dot: "bg-slate-400", text: "text-slate-500 dark:text-slate-400", fill: "#94a3b8",
  badge: "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300",
};
const BLUE: StatusStyle = {
  dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", fill: "#0ea5e9",
  badge: "bg-sky-500/10 text-sky-700 ring-sky-600/20 dark:text-sky-300",
};

/** healthy=green, warning=amber, critical=red, unreachable=purple, unknown=gray, maintenance=blue. */
export const STATUS_STYLES: Record<string, StatusStyle> = {
  healthy: GREEN,
  up: GREEN,
  ok: GREEN,
  active: GREEN,
  sent: GREEN,
  warning: AMBER,
  degraded: AMBER,
  at_risk: AMBER,
  pending: AMBER,
  critical: RED,
  down: RED,
  breached: RED,
  failed: RED,
  firing: RED,
  unreachable: PURPLE,
  unknown: GRAY,
  skipped: GRAY,
  no_data: GRAY,
  revoked: GRAY,
  suppressed: GRAY,
  maintenance: BLUE,
};

export function statusStyle(status: string | null | undefined): StatusStyle {
  return STATUS_STYLES[status ?? "unknown"] ?? GRAY;
}

export const SEVERITY_STYLES: Record<Severity, { badge: string; fill: string }> = {
  critical: { badge: "bg-red-500/10 text-red-700 ring-red-600/25 dark:text-red-300", fill: "#ef4444" },
  high: { badge: "bg-orange-500/10 text-orange-700 ring-orange-600/25 dark:text-orange-300", fill: "#f97316" },
  warning: { badge: "bg-amber-500/10 text-amber-700 ring-amber-600/25 dark:text-amber-300", fill: "#f59e0b" },
  info: { badge: "bg-sky-500/10 text-sky-700 ring-sky-600/25 dark:text-sky-300", fill: "#0ea5e9" },
};

export function severityStyle(sev: string | null | undefined): { badge: string; fill: string } {
  return SEVERITY_STYLES[(sev ?? "info") as Severity] ?? SEVERITY_STYLES.info;
}

export const INCIDENT_STATUS_STYLES: Record<IncidentStatus, string> = {
  triggered: "bg-red-500/10 text-red-700 ring-red-600/25 dark:text-red-300",
  reopened: "bg-red-500/10 text-red-700 ring-red-600/25 dark:text-red-300",
  acknowledged: "bg-amber-500/10 text-amber-700 ring-amber-600/25 dark:text-amber-300",
  investigating: "bg-violet-500/10 text-violet-700 ring-violet-600/25 dark:text-violet-300",
  resolved: "bg-emerald-500/10 text-emerald-700 ring-emerald-600/25 dark:text-emerald-300",
};

export const LOG_SEVERITY_COLORS: Record<string, string> = {
  emergency: "#7f1d1d",
  alert: "#991b1b",
  critical: "#dc2626",
  error: "#ef4444",
  warning: "#f59e0b",
  notice: "#0ea5e9",
  info: "#64748b",
  debug: "#a1a1aa",
};

/** Categorical palette for multi-series charts (readable on light and dark backgrounds). */
export const SERIES_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#84cc16",
  "#f97316", "#6366f1"];

export const OPEN_INCIDENT_STATUSES: IncidentStatus[] = ["triggered", "acknowledged", "investigating", "reopened"];

export function isOpenIncident(status: string): boolean {
  return (OPEN_INCIDENT_STATUSES as string[]).includes(status);
}

export const KIND_LABELS: Record<string, string> = {
  server: "Server",
  website: "Website",
  api: "API",
  network_device: "Network device",
  database: "Database",
  application: "Application",
  service: "Service",
};

/** Route of the detail page for a resource kind. */
export function resourcePath(kind: string | null | undefined, id: string): string {
  switch (kind) {
    case "server":
      return `/servers/${id}`;
    case "website":
    case "api":
      return `/websites/${id}`;
    case "network_device":
      return `/network-devices/${id}`;
    default:
      return `/services/${id}`;
  }
}
