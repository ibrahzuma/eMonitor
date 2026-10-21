import { api, CSRF_COOKIE, downloadFile, readCookie, type Query } from "@/api/client";
import type {
  Agent,
  AlertRule,
  AlertRuleIn,
  ApiKey,
  ApiKeyCreated,
  AuditEntry,
  BulkResult,
  Channel,
  ChannelIn,
  Check,
  CheckIn,
  CheckResult,
  CheckTimeseries,
  CheckUpdate,
  DashboardSummary,
  DashboardTraffic,
  DashboardTrends,
  Delivery,
  Dependency,
  DependencyMap,
  EnrollmentToken,
  EnrollmentTokenCreated,
  EnrollmentTokenIn,
  Facet,
  Group,
  GroupIn,
  ImportResult,
  Inbox,
  Incident,
  IncidentDetail,
  LogFacetField,
  LogHistogram,
  LogRow,
  LogSearchResult,
  MaintenanceWindow,
  MaintenanceWindowIn,
  ManualIncidentIn,
  Me,
  Member,
  MemberCreate,
  Message,
  MetricLatest,
  MetricName,
  MetricSeries,
  NetworkDeviceCreate,
  Organization,
  OrgCreate,
  OrgUpdate,
  Page,
  Policy,
  PolicyIn,
  Report,
  ReportName,
  Resource,
  ResourceAvailability,
  ResourceCreate,
  ResourceUpdate,
  RulePreviewRow,
  RuleState,
  SavedSearch,
  ServerCreate,
  ServerUpdate,
  ServiceCreate,
  SessionInfo,
  Slo,
  SloIn,
  SystemStatus,
  Team,
  TeamIn,
  TelemetryEvent,
  TokenResponse,
  TotpSetup,
  User,
  WebsiteCreate,
  JsonObject,
  AssignableRole,
  Role,
} from "@/types/api";

const csrfHeader = (): Record<string, string> => {
  const v = readCookie(CSRF_COOKIE);
  return v ? { "X-CSRF-Token": v } : {};
};

// ---------------------------------------------------------------- auth

export const authApi = {
  login: (email: string, password: string) =>
    api.post<TokenResponse>("/auth/login", { email, password }, { anonymous: true, withCredentials: true }),
  loginMfa: (mfa_token: string, code: string) =>
    api.post<TokenResponse>("/auth/login/mfa", { mfa_token, code }, { anonymous: true, withCredentials: true }),
  logout: () =>
    api.post<Message>("/auth/logout", {}, { anonymous: true, withCredentials: true, headers: csrfHeader(), noRefresh: true }),
  me: () => api.get<Me>("/auth/me", undefined, { organizationId: null }),
  updateMe: (body: { full_name?: string; timezone?: string; telegram_chat_id?: string }) =>
    api.patch<User>("/auth/me", body, { organizationId: null }),
  changePassword: (current_password: string, new_password: string) =>
    api.post<Message>("/auth/change-password", { current_password, new_password }, { organizationId: null }),
  forgotPassword: (email: string) => api.post<Message>("/auth/forgot-password", { email }, { anonymous: true }),
  resetPassword: (token: string, new_password: string) =>
    api.post<Message>("/auth/reset-password", { token, new_password }, { anonymous: true }),
  totpSetup: () => api.post<TotpSetup>("/auth/2fa/setup", {}, { organizationId: null }),
  totpEnable: (code: string) => api.post<Message>("/auth/2fa/enable", { code }, { organizationId: null }),
  totpDisable: (code: string, password: string) =>
    api.post<Message>("/auth/2fa/disable", { code, password }, { organizationId: null }),
  sessions: () => api.get<SessionInfo[]>("/auth/sessions", undefined, { organizationId: null }),
  revokeSession: (id: string) => api.delete<Message>(`/auth/sessions/${id}`, { organizationId: null }),
};

// ---------------------------------------------------------------- organizations, users, teams, keys, audit

export const orgApi = {
  list: () => api.get<Organization[]>("/organizations", undefined, { organizationId: null }),
  create: (body: OrgCreate) => api.post<Organization>("/organizations", body, { organizationId: null }),
  current: () => api.get<Organization>("/organizations/current"),
  update: (body: OrgUpdate) => api.patch<Organization>("/organizations/current", body),
};

export const usersApi = {
  list: (q: Query = {}) => api.get<Page<Member>>("/users", q),
  create: (body: MemberCreate) => api.post<Member>("/users", body),
  update: (id: string, body: { role?: AssignableRole | Role; is_active?: boolean; full_name?: string }) =>
    api.patch<Member>(`/users/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/users/${id}`),
};

export const teamsApi = {
  list: () => api.get<Team[]>("/teams"),
  create: (body: TeamIn) => api.post<Team>("/teams", body),
  update: (id: string, body: TeamIn) => api.put<Team>(`/teams/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/teams/${id}`),
};

export const apiKeysApi = {
  list: () => api.get<ApiKey[]>("/api-keys"),
  create: (body: { name: string; role: AssignableRole; scopes: string[]; expires_at: string | null }) =>
    api.post<ApiKeyCreated>("/api-keys", body),
  revoke: (id: string) => api.delete<Message>(`/api-keys/${id}`),
};

export const auditApi = {
  list: (q: Query) => api.get<Page<AuditEntry>>("/audit-logs", q),
};

export const systemApi = {
  status: () => api.get<SystemStatus>("/system/status", undefined, { organizationId: null }),
  live: () => api.get<{ status: string }>("/health/live", undefined, { anonymous: true }),
};

// ---------------------------------------------------------------- resources

export const resourcesApi = {
  list: (q: Query) => api.get<Page<Resource>>("/resources", q),
  get: (id: string) => api.get<Resource>(`/resources/${id}`),
  create: (body: ResourceCreate) => api.post<Resource>("/resources", body),
  update: (id: string, body: ResourceUpdate) => api.patch<Resource>(`/resources/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/resources/${id}`),
  events: (id: string, range = "7d", limit = 200) =>
    api.get<TelemetryEvent[]>(`/resources/${id}/events`, { range, limit }),
  availability: (id: string, q: Query) => api.get<ResourceAvailability>(`/resources/${id}/availability`, q),
  dependencies: (id: string) => api.get<Dependency[]>(`/resources/${id}/dependencies`),
  addDependency: (id: string, depends_on_id: string, description = "") =>
    api.post<Dependency>(`/resources/${id}/dependencies`, { depends_on_id, description }),
  removeDependency: (id: string, depId: string) => api.delete<Message>(`/resources/${id}/dependencies/${depId}`),
  dependencyMap: () => api.get<DependencyMap>("/resources/dependency-map"),
  import: (items: JsonObject[], dry_run: boolean) => api.post<ImportResult>("/resources/import", { items, dry_run }),
  checks: (id: string) => api.get<Check[]>(`/resources/${id}/checks`),
  addCheck: (id: string, body: CheckIn) => api.post<Check>(`/resources/${id}/checks`, body),
};

export const serversApi = {
  list: (q: Query) => api.get<Page<Resource>>("/servers", q),
  create: (body: ServerCreate) => api.post<Resource>("/servers", body),
  update: (id: string, body: ServerUpdate) => api.patch<Resource>(`/servers/${id}`, body),
};

export const websitesApi = {
  list: (q: Query) => api.get<Page<Resource>>("/websites", q),
  create: (body: WebsiteCreate) => api.post<Resource>("/websites", body),
};

export const devicesApi = {
  list: (q: Query) => api.get<Page<Resource>>("/network-devices", q),
  create: (body: NetworkDeviceCreate) => api.post<Resource>("/network-devices", body),
};

export const servicesApi = {
  list: (q: Query) => api.get<Page<Resource>>("/services", q),
  create: (body: ServiceCreate) => api.post<Resource>("/services", body),
};

export const groupsApi = {
  list: () => api.get<Group[]>("/groups"),
  create: (body: GroupIn) => api.post<Group>("/groups", body),
  update: (id: string, body: GroupIn) => api.put<Group>(`/groups/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/groups/${id}`),
};

export const checksApi = {
  get: (id: string) => api.get<Check>(`/checks/${id}`),
  update: (id: string, body: CheckUpdate) => api.patch<Check>(`/checks/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/checks/${id}`),
  run: (id: string) => api.post<Message>(`/checks/${id}/run`),
  results: (id: string, q: Query) => api.get<CheckResult[]>(`/checks/${id}/results`, q),
  timeseries: (id: string, q: Query) => api.get<CheckTimeseries>(`/checks/${id}/timeseries`, q),
};

// ---------------------------------------------------------------- telemetry

export const metricsApi = {
  series: (q: Query) => api.get<MetricSeries>("/metrics/series", q),
  latest: (resource_id: string) => api.get<MetricLatest[]>("/metrics/latest", { resource_id }),
  names: (resource_id: string) => api.get<MetricName[]>("/metrics/names", { resource_id }),
};

export const logsApi = {
  search: (q: Query) => api.get<LogSearchResult>("/logs/search", q),
  histogram: (q: Query) => api.get<LogHistogram>("/logs/histogram", q),
  facets: (field: LogFacetField, q: Query) => api.get<Facet[]>("/logs/facets", { ...q, field }),
  export: (q: Query) => downloadFile("/logs/export", q, "logs.csv"),
};

export const savedSearchesApi = {
  list: (kind?: string) => api.get<SavedSearch[]>("/saved-searches", { kind }),
  create: (body: { name: string; kind: string; query: JsonObject; shared: boolean }) =>
    api.post<SavedSearch>("/saved-searches", body),
  remove: (id: string) => api.delete<Message>(`/saved-searches/${id}`),
};

// ---------------------------------------------------------------- agents

export const agentsApi = {
  list: () => api.get<Agent[]>("/agents"),
  revoke: (id: string) => api.post<Message>(`/agents/${id}/revoke`),
  tokens: () => api.get<EnrollmentToken[]>("/agents/enrollment-tokens"),
  createToken: (body: EnrollmentTokenIn) => api.post<EnrollmentTokenCreated>("/agents/enrollment-tokens", body),
  revokeToken: (id: string) => api.delete<Message>(`/agents/enrollment-tokens/${id}`),
};

// ---------------------------------------------------------------- incidents

export const incidentsApi = {
  list: (q: Query) => api.get<Page<Incident>>("/incidents", q),
  get: (id: string) => api.get<IncidentDetail>(`/incidents/${id}`),
  create: (body: ManualIncidentIn) => api.post<IncidentDetail>("/incidents", body),
  update: (id: string, body: { title?: string; description?: string; severity?: string }) =>
    api.patch<IncidentDetail>(`/incidents/${id}`, body),
  acknowledge: (id: string, note = "") => api.post<IncidentDetail>(`/incidents/${id}/acknowledge`, { note }),
  investigate: (id: string, note = "") => api.post<IncidentDetail>(`/incidents/${id}/investigate`, { note }),
  assign: (id: string, assignee_id: string | null) =>
    api.post<IncidentDetail>(`/incidents/${id}/assign`, { assignee_id }),
  comment: (id: string, note: string) => api.post<IncidentDetail>(`/incidents/${id}/comments`, { note }),
  resolve: (id: string, resolution: string) => api.post<IncidentDetail>(`/incidents/${id}/resolve`, { resolution }),
  reopen: (id: string, note = "") => api.post<IncidentDetail>(`/incidents/${id}/reopen`, { note }),
  bulk: (ids: string[], action: "acknowledge" | "resolve", note = "") =>
    api.post<BulkResult>("/incidents/bulk", { ids, action, note }),
  export: (q: Query) => downloadFile("/incidents/export", q, "incidents.csv"),
};

// ---------------------------------------------------------------- alert rules

export const alertsApi = {
  list: () => api.get<AlertRule[]>("/alerts/rules"),
  get: (id: string) => api.get<AlertRule>(`/alerts/rules/${id}`),
  create: (body: AlertRuleIn) => api.post<AlertRule>("/alerts/rules", body),
  update: (id: string, body: AlertRuleIn) => api.put<AlertRule>(`/alerts/rules/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/alerts/rules/${id}`),
  states: (id: string) => api.get<RuleState[]>(`/alerts/rules/${id}/states`),
  preview: (id: string) => api.post<RulePreviewRow[]>(`/alerts/rules/${id}/preview`),
};

// ---------------------------------------------------------------- notifications

export const notificationsApi = {
  channels: () => api.get<Channel[]>("/notifications/channels"),
  createChannel: (body: ChannelIn) => api.post<Channel>("/notifications/channels", body),
  updateChannel: (id: string, body: ChannelIn) => api.put<Channel>(`/notifications/channels/${id}`, body),
  deleteChannel: (id: string) => api.delete<Message>(`/notifications/channels/${id}`),
  testChannel: (id: string) => api.post<Message>(`/notifications/channels/${id}/test`),
  policies: () => api.get<Policy[]>("/notifications/policies"),
  createPolicy: (body: PolicyIn) => api.post<Policy>("/notifications/policies", body),
  updatePolicy: (id: string, body: PolicyIn) => api.put<Policy>(`/notifications/policies/${id}`, body),
  deletePolicy: (id: string) => api.delete<Message>(`/notifications/policies/${id}`),
  deliveries: (q: Query) => api.get<Page<Delivery>>("/notifications/deliveries", q),
  retryDelivery: (id: string) => api.post<Message>(`/notifications/deliveries/${id}/retry`),
  inbox: (unread = false, limit = 30) => api.get<Inbox>("/notifications/inbox", { unread, limit }),
  markRead: (ids: string[] | null) => api.post<Message>("/notifications/inbox/read", { ids }),
};

// ---------------------------------------------------------------- maintenance

export const maintenanceApi = {
  list: (include_expired = false) => api.get<MaintenanceWindow[]>("/maintenance", { include_expired }),
  create: (body: MaintenanceWindowIn) => api.post<MaintenanceWindow>("/maintenance", body),
  update: (id: string, body: MaintenanceWindowIn) => api.put<MaintenanceWindow>(`/maintenance/${id}`, body),
  end: (id: string) => api.post<MaintenanceWindow>(`/maintenance/${id}/end`),
  remove: (id: string) => api.delete<Message>(`/maintenance/${id}`),
};

// ---------------------------------------------------------------- reports & SLOs

export const reportsApi = {
  get: (name: ReportName, q: Query) => api.get<Report>(`/reports/${name}`, q),
  download: (name: ReportName, q: Query, format: "csv" | "pdf") =>
    downloadFile(`/reports/${name}`, { ...q, format }, `${name}.${format}`),
};

export const slosApi = {
  list: (live = true) => api.get<Slo[]>("/slos", { live }),
  get: (id: string) => api.get<Slo>(`/slos/${id}`),
  create: (body: SloIn) => api.post<Slo>("/slos", body),
  update: (id: string, body: SloIn) => api.put<Slo>(`/slos/${id}`, body),
  remove: (id: string) => api.delete<Message>(`/slos/${id}`),
};

// ---------------------------------------------------------------- dashboard

export const dashboardApi = {
  summary: (q: Query) => api.get<DashboardSummary>("/dashboard/summary", q),
  trends: (q: Query) => api.get<DashboardTrends>("/dashboard/trends", q),
  traffic: (q: Query) => api.get<DashboardTraffic>("/dashboard/traffic", q),
  activity: (limit = 40) => api.get<TelemetryEvent[]>("/dashboard/activity", { limit }),
  logErrors: (limit = 10) => api.get<LogRow[]>("/dashboard/log-errors", { limit }),
};
