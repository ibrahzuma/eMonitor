import type { Query } from "@/api/client";

/**
 * TanStack Query keys. The first element is a stable domain prefix so that WebSocket events and mutations
 * can invalidate whole domains (e.g. every key starting with "incidents"). Switching organization clears the
 * whole cache, so keys are not scoped by organization id.
 */
export const qk = {
  me: ["me"] as const,
  sessions: ["sessions"] as const,
  org: ["org", "current"] as const,
  orgs: ["org", "all"] as const,
  systemStatus: ["system", "status"] as const,

  dashboard: ["dashboard"] as const,
  dashboardPart: (part: string, q?: Query) => ["dashboard", part, q ?? {}] as const,

  resources: ["resources"] as const,
  resourceList: (scope: string, q: Query) => ["resources", "list", scope, q] as const,
  resource: (id: string) => ["resources", "detail", id] as const,
  resourceEvents: (id: string, range: string) => ["resources", "events", id, range] as const,
  resourceAvailability: (id: string, q: Query) => ["resources", "availability", id, q] as const,
  resourceDependencies: (id: string) => ["resources", "dependencies", id] as const,
  dependencyMap: ["resources", "dependency-map"] as const,
  groups: ["groups"] as const,

  checks: ["checks"] as const,
  checkResults: (id: string, q: Query) => ["checks", "results", id, q] as const,
  checkTimeseries: (id: string, q: Query) => ["checks", "timeseries", id, q] as const,

  metrics: ["metrics"] as const,
  metricNames: (rid: string) => ["metrics", "names", rid] as const,
  metricLatest: (rid: string) => ["metrics", "latest", rid] as const,
  metricSeries: (q: Query) => ["metrics", "series", q] as const,

  logs: ["logs"] as const,
  logSearch: (q: Query) => ["logs", "search", q] as const,
  logHistogram: (q: Query) => ["logs", "histogram", q] as const,
  logFacets: (field: string, q: Query) => ["logs", "facets", field, q] as const,
  savedSearches: (kind: string) => ["saved-searches", kind] as const,

  agents: ["agents"] as const,
  enrollmentTokens: ["agents", "tokens"] as const,

  incidents: ["incidents"] as const,
  incidentList: (q: Query) => ["incidents", "list", q] as const,
  incident: (id: string) => ["incidents", "detail", id] as const,

  alertRules: ["alert-rules"] as const,
  alertRule: (id: string) => ["alert-rules", id] as const,
  alertRuleStates: (id: string) => ["alert-rules", id, "states"] as const,

  channels: ["notifications", "channels"] as const,
  policies: ["notifications", "policies"] as const,
  deliveries: (q: Query) => ["notifications", "deliveries", q] as const,
  inbox: ["inbox"] as const,

  maintenance: ["maintenance"] as const,
  report: (name: string, q: Query) => ["reports", name, q] as const,
  slos: ["slos"] as const,

  users: ["users"] as const,
  userList: (q: Query) => ["users", q] as const,
  teams: ["teams"] as const,
  apiKeys: ["api-keys"] as const,
  audit: (q: Query) => ["audit", q] as const,
};
