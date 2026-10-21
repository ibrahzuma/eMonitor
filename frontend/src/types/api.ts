/**
 * TypeScript mirror of the eMonitor backend contracts (backend/app/api/v1/*.py, backend/app/schemas/*.py).
 * All timestamps are UTC ISO-8601 strings. UUIDs are strings.
 */

export type UUID = string;
export type ISODate = string;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------- enums

export const ROLES = ["org_admin", "it_admin", "operator", "viewer"] as const;
export type AssignableRole = (typeof ROLES)[number];
export type Role = AssignableRole | "super_admin";

export const RESOURCE_KINDS = ["server", "website", "api", "network_device", "database", "application", "service"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const ENVIRONMENTS = ["production", "staging", "development", "testing"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const HEALTH_STATUSES = ["healthy", "warning", "critical", "unreachable", "unknown", "maintenance"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const CHECK_TYPES = ["http", "tcp", "icmp", "dns", "tls", "smtp", "ssh", "postgres", "mysql", "redis", "snmp", "domain"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_OUTCOMES = ["up", "degraded", "down", "unknown", "skipped"] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const SEVERITIES = ["critical", "high", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_STATUSES = ["triggered", "acknowledged", "investigating", "resolved", "reopened"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SOURCES = ["check", "metric", "agent", "ssl", "rule", "log", "slo", "manual"] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const ALERT_RULE_TYPES = [
  "metric_threshold",
  "response_time",
  "consecutive_failures",
  "website_down",
  "ssl_expiry",
  "log_pattern",
  "error_rate",
  "missing_telemetry",
  "agent_disconnected",
  "composite",
] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

export const CHANNEL_TYPES = ["email", "telegram", "webhook", "in_app"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const DELIVERY_STATUSES = ["pending", "sent", "failed", "suppressed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const LOG_SEVERITIES = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

export const PERMISSIONS = [
  "view",
  "resources:write",
  "agents:manage",
  "incidents:operate",
  "incidents:bulk",
  "alerts:manage",
  "notifications:manage",
  "maintenance:manage",
  "slo:manage",
  "logs:read",
  "logs:write",
  "metrics:write",
  "users:manage",
  "api_keys:manage",
  "org:settings",
  "audit:read",
  "platform:admin",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// ---------------------------------------------------------------- common

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Message {
  message: string;
}

export interface ApiErrorDetail {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details: unknown;
    request_id: string | null;
  };
}

// ---------------------------------------------------------------- auth

export interface User {
  id: UUID;
  email: string;
  full_name: string;
  timezone: string;
  is_superadmin: boolean;
  totp_enabled: boolean;
  telegram_chat_id: string | null;
  last_login_at: ISODate | null;
}

export interface Membership {
  organization_id: UUID;
  organization_name: string;
  organization_slug: string;
  role: Role;
}

export interface Me {
  user: User;
  memberships: Membership[];
  permissions: Record<string, Permission[]>;
}

export interface TokenResponse {
  access_token: string | null;
  token_type: string;
  expires_in: number | null;
  mfa_required: boolean;
  mfa_token: string | null;
  user: User | null;
}

export interface TotpSetup {
  secret: string;
  otpauth_url: string;
}

export interface SessionInfo {
  id: UUID;
  created_at: ISODate;
  last_used_at: ISODate;
  expires_at: ISODate;
  user_agent: string;
  ip_address: string;
  current: boolean;
}

// ---------------------------------------------------------------- organizations / users

export interface OrgSettings {
  session_idle_minutes?: number;
  reopen_window_minutes?: number;
  agent_timeout_seconds?: number;
  ssl_alert_days?: number[];
  log_retention_days?: number;
  metric_retention_days?: number;
  logs_per_day_quota?: number;
  metric_consecutive_samples?: number;
  unreachable_after_failures?: number;
}

export interface ThresholdPair {
  warning?: number | null;
  critical?: number | null;
}

export interface MonitoringScope {
  allow_public: boolean;
  cidrs: string[];
  hostnames: string[];
}

export interface Organization {
  id: UUID;
  name: string;
  slug: string;
  timezone: string;
  is_active: boolean;
  settings: OrgSettings;
  thresholds: Record<string, ThresholdPair>;
  monitoring_scope: MonitoringScope;
  created_at: ISODate;
}

export interface OrgCreate {
  name: string;
  slug: string;
  timezone: string;
  admin_email?: string | null;
}

export interface OrgUpdate {
  name?: string;
  timezone?: string;
  settings?: OrgSettings;
  thresholds?: Record<string, ThresholdPair>;
  monitoring_scope?: MonitoringScope;
}

export interface Member {
  user_id: UUID;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  totp_enabled: boolean;
  last_login_at: ISODate | null;
  created_at: ISODate;
}

export interface MemberCreate {
  email: string;
  full_name: string;
  role: AssignableRole;
  password?: string | null;
}

export interface Team {
  id: UUID;
  name: string;
  description: string;
  member_ids: UUID[];
  created_at: ISODate;
}

export interface TeamIn {
  name: string;
  description: string;
  member_ids: UUID[];
}

export interface ApiKey {
  id: UUID;
  name: string;
  prefix: string;
  role: Role;
  scopes: string[];
  created_at: ISODate;
  last_used_at: ISODate | null;
  expires_at: ISODate | null;
  revoked_at: ISODate | null;
}

export interface ApiKeyCreated extends ApiKey {
  key: string;
}

export interface AuditEntry {
  id: UUID;
  actor_label: string;
  actor_user_id: UUID | null;
  action: string;
  target_type: string;
  target_id: string;
  details: JsonObject;
  ip_address: string;
  request_id: string;
  created_at: ISODate;
}

// ---------------------------------------------------------------- resources & checks

export interface Check {
  id: UUID;
  resource_id: UUID;
  name: string;
  type: CheckType;
  config: JsonObject;
  has_secrets: boolean;
  interval_seconds: number;
  timeout_seconds: number;
  failure_threshold: number;
  recovery_threshold: number;
  severity: Severity;
  enabled: boolean;
  next_run_at: ISODate;
  last_run_at: ISODate | null;
  last_outcome: CheckOutcome | string;
  last_message: string;
  last_latency_ms: number | null;
  last_details: JsonObject;
  consecutive_failures: number;
  consecutive_successes: number;
  state: HealthStatus | string;
  state_changed_at: ISODate;
  created_at: ISODate;
}

export interface CheckIn {
  name: string;
  type: CheckType;
  config: JsonObject;
  secrets?: JsonObject | null;
  interval_seconds?: number;
  timeout_seconds?: number;
  failure_threshold?: number;
  recovery_threshold?: number;
  severity?: Severity;
  enabled?: boolean;
}

export type CheckUpdate = Partial<Omit<CheckIn, "type">>;

export interface ServerLatest {
  cpu_percent?: number;
  memory_percent?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  swap_percent?: number;
  process_count?: number;
  uptime_seconds?: number;
  memory_used_bytes?: number;
  memory_available_bytes?: number;
  tcp_connections?: number;
  disk_percent_max?: number;
  disks?: Record<string, number>;
  ts?: ISODate | null;
}

export interface ServerDetail {
  hostname: string;
  ip_address: string;
  os_family: "linux" | "windows" | "other" | string;
  os_version: string;
  kernel: string;
  cpu_count: number | null;
  memory_total_bytes: number | null;
  monitoring_interval_seconds: number;
  agent_timeout_seconds: number | null;
  thresholds: Record<string, ThresholdPair>;
  monitored_services: string[];
  last_metrics_at: ISODate | null;
  uptime_seconds: number | null;
  latest: ServerLatest;
}

export interface AgentBrief {
  id: UUID;
  status: "pending" | "active" | "revoked" | string;
  version: string;
  last_seen_at: ISODate | null;
  last_ip: string;
  collection_interval_seconds: number;
  spool_depth: number;
  last_error: string;
  enrolled_at: ISODate;
}

export interface Resource {
  id: UUID;
  kind: ResourceKind;
  name: string;
  description: string;
  address: string;
  environment: Environment | string;
  location: string;
  business_owner: string;
  group_id: UUID | null;
  team_id: UUID | null;
  tags: string[];
  custom_fields: Record<string, string | number | boolean | null>;
  attributes: JsonObject;
  status: HealthStatus;
  status_reason: string;
  status_changed_at: ISODate;
  is_paused: boolean;
  created_at: ISODate;
  updated_at: ISODate;
  server: ServerDetail | null;
  agent: AgentBrief | null;
  checks: Check[] | null;
  open_incidents: number | null;
  uptime_24h: number | null;
}

export interface ResourceBaseIn {
  name: string;
  description?: string;
  address?: string;
  environment?: Environment;
  location?: string;
  business_owner?: string;
  group_id?: UUID | null;
  team_id?: UUID | null;
  tags?: string[];
  custom_fields?: Record<string, string | number | boolean | null>;
  attributes?: JsonObject;
  notification_policy_id?: UUID | null;
}

export interface ResourceUpdate extends Partial<ResourceBaseIn> {
  is_paused?: boolean;
}

export interface ServerCreate extends ResourceBaseIn {
  hostname?: string;
  ip_address?: string;
  os_family?: "linux" | "windows" | "other";
  os_version?: string;
  monitoring_interval_seconds?: number;
  agent_timeout_seconds?: number | null;
  thresholds?: Record<string, ThresholdPair>;
  monitored_services?: string[];
  ping_check?: boolean;
}

export type ServerUpdate = ResourceUpdate & Partial<Omit<ServerCreate, "ping_check" | keyof ResourceBaseIn>>;

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export interface JsonAssertion {
  path: string;
  op: "eq" | "ne" | "exists" | "contains" | "gt" | "lt";
  value?: JsonValue;
}

export interface WebsiteCreate extends ResourceBaseIn {
  url: string;
  kind?: "website" | "api";
  method?: HttpMethod;
  expected_status?: string[];
  interval_seconds?: number;
  timeout_seconds?: number;
  keyword?: string | null;
  keyword_absent?: boolean;
  headers?: Record<string, string>;
  body?: string | null;
  expected_headers?: Record<string, string>;
  json_assertions?: JsonAssertion[];
  verify_tls?: boolean;
  ssl_check?: boolean;
  ssl_alert_days?: number[] | null;
  degraded_threshold_ms?: number | null;
  follow_redirects?: boolean;
  failure_threshold?: number;
  severity?: Severity;
  secrets?: JsonObject | null;
  monitor_dns?: boolean;
  dns_record_type?: "A" | "AAAA" | "CNAME";
  monitor_domain?: boolean;
  domain?: string | null;
  domain_alert_days?: number[] | null;
}

export type DeviceType = "router" | "switch" | "firewall" | "access_point" | "load_balancer" | "other";

export interface NetworkDeviceCreate extends ResourceBaseIn {
  host: string;
  vendor?: string;
  model?: string;
  device_type?: DeviceType;
  ping?: boolean;
  ping_interval_seconds?: number;
  snmp?: JsonObject | null;
  snmp_secrets?: JsonObject | null;
  snmp_interval_seconds?: number;
}

export interface ServiceCreate extends ResourceBaseIn {
  kind: "service" | "database" | "application" | "api";
  checks: CheckIn[];
}

export interface ResourceCreate extends ResourceBaseIn {
  kind: ResourceKind;
  checks?: CheckIn[];
}

export interface Group {
  id: UUID;
  name: string;
  description: string;
  parent_id: UUID | null;
  created_at: ISODate;
  resource_count: number;
}

export interface GroupIn {
  name: string;
  description: string;
  parent_id: UUID | null;
}

export interface Dependency {
  id: UUID;
  resource_id: UUID;
  depends_on_id: UUID;
  description: string;
}

export interface DependencyMap {
  nodes: { id: UUID; name: string; kind: ResourceKind; status: HealthStatus }[];
  edges: { id: UUID; from: UUID; to: UUID; description: string }[];
}

export interface ImportRowError {
  index: number;
  errors: { loc?: (string | number)[]; msg: string; details?: unknown }[];
}

export interface ImportResult {
  created: number;
  errors: ImportRowError[];
  ids: UUID[];
}

export interface Availability {
  expected: number;
  up: number;
  degraded: number;
  down: number;
  unknown: number;
  maintenance: number;
  uptime_percent: number | null;
  coverage_percent: number;
  downtime_seconds: number;
  avg_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export interface ResourceAvailability {
  start: ISODate;
  end: ISODate;
  resource: Availability | null;
  checks: (Availability & { check_id: UUID; name: string; type: CheckType })[];
}

export interface TelemetryEvent {
  ts: ISODate;
  id: UUID;
  resource_id: UUID;
  kind: string;
  severity: string;
  title: string;
  message: string;
  data: JsonObject;
}

export interface CheckResult {
  scheduled_at: ISODate;
  executed_at: ISODate | null;
  status: CheckOutcome;
  latency_ms: number | null;
  dns_ms: number | null;
  connect_ms: number | null;
  tls_ms: number | null;
  ttfb_ms: number | null;
  http_status: number | null;
  message: string;
  details: JsonObject;
  in_maintenance: number | boolean;
}

export interface CheckBucket {
  bucket: ISODate;
  up: number;
  degraded: number;
  down: number;
  unknown: number;
  maintenance: number;
  avg_ms: number | null;
}

export interface CheckTimeseries {
  bucket_seconds: number;
  points: CheckBucket[];
}

// ---------------------------------------------------------------- metrics

export interface MetricName {
  metric: string;
  instance: string;
}

export interface MetricLatest {
  metric: string;
  instance: string;
  value: number;
  ts: ISODate;
}

export interface MetricSeries {
  metric: string;
  start: ISODate;
  end: ISODate;
  step: number;
  agg: string;
  series: { resource_id: UUID; instance: string; points: [ISODate, number][] }[];
}

// ---------------------------------------------------------------- logs

export interface LogRow {
  ts: ISODate;
  id: UUID;
  resource_id: UUID;
  host: string;
  application: string;
  service: string;
  source: string;
  environment: string;
  severity: LogSeverity | string;
  message: string;
  trace_id: string;
  attributes: Record<string, string>;
}

export interface LogSearchResult {
  items: LogRow[];
  next_cursor: string | null;
  start: ISODate;
  end: ISODate;
}

export interface LogHistogram {
  bucket_seconds: number;
  points: { bucket: ISODate; severity: string; count: number }[];
}

export interface Facet {
  value: string;
  count: number;
}

export type LogFacetField = "host" | "application" | "service" | "source" | "severity" | "environment";

export interface SavedSearch {
  id: UUID;
  user_id: UUID;
  name: string;
  kind: "logs" | "resources" | "incidents";
  query: JsonObject;
  shared: boolean;
  created_at: ISODate;
}

// ---------------------------------------------------------------- agents

export interface EnrollmentToken {
  id: UUID;
  description: string;
  server_id: UUID | null;
  max_uses: number;
  use_count: number;
  created_at: ISODate;
  expires_at: ISODate;
  revoked_at: ISODate | null;
}

export interface EnrollmentTokenCreated extends EnrollmentToken {
  token: string;
  install_command: string;
}

export interface AgentInfo {
  server_url: string;
  install_script_url: string;
  package_url: string;
  agent_version: string;
  package_sha256: string;
  install_command_template: string;
  upgrade_command: string;
}

export interface EnrollmentTokenIn {
  description?: string;
  server_id?: UUID | null;
  max_uses?: number;
  expires_in_hours?: number;
  environment?: string | null;
  group_id?: UUID | null;
  tags?: string[];
}

export interface Agent {
  id: UUID;
  server_id: UUID;
  status: string;
  version: string;
  reported_hostname: string;
  last_seen_at: ISODate | null;
  last_ip: string;
  collection_interval_seconds: number;
  spool_depth: number;
  last_error: string;
  enrolled_at: ISODate;
  revoked_at: ISODate | null;
  rotated_at: ISODate | null;
  server_name: string | null;
}

// ---------------------------------------------------------------- incidents

export interface Incident {
  id: UUID;
  number: number;
  title: string;
  description: string;
  severity: Severity;
  status: IncidentStatus;
  source: IncidentSource | string;
  source_id: string;
  dedup_key: string;
  resource_id: UUID | null;
  team_id: UUID | null;
  assignee_id: UUID | null;
  alert_rule_id: UUID | null;
  trigger_condition: string;
  evidence: JsonObject;
  first_detected_at: ISODate;
  last_detected_at: ISODate;
  acknowledged_at: ISODate | null;
  acknowledged_by_id: UUID | null;
  resolved_at: ISODate | null;
  resolved_by_id: UUID | null;
  resolution: string;
  occurrence_count: number;
  reopen_count: number;
  in_maintenance: boolean;
  escalation_step: number;
  created_at: ISODate;
  group_key: string;
  duration_seconds: number;
  resource_name: string | null;
  resource_kind: ResourceKind | null;
  assignee_name: string | null;
}

export interface IncidentEvent {
  id: UUID;
  kind: string;
  actor_user_id: UUID | null;
  message: string;
  data: JsonObject;
  created_at: ISODate;
  actor_name: string | null;
}

export interface DeliveryBrief {
  id: UUID;
  channel_type: ChannelType;
  event: string;
  status: DeliveryStatus;
  status_reason: string;
  attempts: number;
  last_error: string;
  created_at: ISODate;
  sent_at: ISODate | null;
}

export interface IncidentDetail extends Incident {
  timeline: IncidentEvent[];
  deliveries: DeliveryBrief[];
  related: Incident[];
}

export interface ManualIncidentIn {
  title: string;
  description?: string;
  severity: Severity;
  resource_id?: UUID | null;
  assignee_id?: UUID | null;
}

export interface BulkResult {
  updated: number;
  not_found: number;
}

// ---------------------------------------------------------------- alert rules

export type Operator = "gt" | "gte" | "lt" | "lte";

export interface RuleTarget {
  resource_ids: UUID[];
  group_ids: UUID[];
  check_ids: UUID[];
  tags: string[];
  kinds: string[];
  environments: string[];
}

export interface AlertRuleIn {
  name: string;
  description: string;
  rule_type: AlertRuleType;
  target: RuleTarget;
  condition: JsonObject;
  severity: Severity;
  evaluation_interval_seconds: number;
  consecutive_breaches: number;
  recovery_consecutive: number;
  cooldown_seconds: number;
  suppress_in_maintenance: boolean;
  auto_resolve: boolean;
  notification_policy_id: UUID | null;
  enabled: boolean;
}

export interface AlertRule extends Omit<AlertRuleIn, "target"> {
  id: UUID;
  target: Partial<RuleTarget>;
  last_eval_at: ISODate | null;
  last_error: string;
  created_at: ISODate;
  firing: number;
}

export interface RuleState {
  subject_key: string;
  state: string;
  breaches: number;
  oks: number;
  last_value: number | null;
  last_fired_at: ISODate | null;
  last_resolved_at: ISODate | null;
  updated_at: ISODate;
}

export interface RulePreviewRow {
  subject: string;
  breached: boolean;
  value: number | null;
  resource: string | null;
  detail: string;
}

// ---------------------------------------------------------------- notifications

export interface Channel {
  id: UUID;
  name: string;
  type: ChannelType;
  config: JsonObject;
  secrets_configured: string[];
  enabled: boolean;
  rate_limit_per_hour: number;
  last_test_at: ISODate | null;
  last_test_ok: boolean | null;
  created_at: ISODate;
}

export interface ChannelIn {
  name: string;
  type: ChannelType;
  config: JsonObject;
  secrets?: JsonObject | null;
  enabled: boolean;
  rate_limit_per_hour: number;
}

export interface EscalationStep {
  delay_minutes: number;
  channel_ids: UUID[];
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  allow_critical: boolean;
  weekdays: number[];
}

export interface PolicyIn {
  name: string;
  description: string;
  is_default: boolean;
  min_severity: Severity;
  team_ids: UUID[];
  steps: EscalationStep[];
  notify_on_ack: boolean;
  notify_on_resolve: boolean;
  quiet_hours: QuietHours;
  templates: { subject?: string; body?: string };
  priority: number;
  enabled: boolean;
}

export interface Policy extends PolicyIn {
  id: UUID;
  created_at: ISODate;
}

export interface Delivery {
  id: UUID;
  incident_id: UUID | null;
  channel_id: UUID | null;
  channel_type: ChannelType;
  event: string;
  step: number;
  status: DeliveryStatus;
  status_reason: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: ISODate | null;
  last_error: string;
  subject: string;
  sent_at: ISODate | null;
  created_at: ISODate;
}

export interface InboxItem {
  id: UUID;
  incident_id: UUID | null;
  title: string;
  body: string;
  severity: string;
  read_at: ISODate | null;
  created_at: ISODate;
}

export interface Inbox {
  items: InboxItem[];
  unread: number;
}

// ---------------------------------------------------------------- maintenance

export interface Recurrence {
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  byweekday: number[];
  until: ISODate | null;
  count: number | null;
}

export interface MaintenanceWindowIn {
  name: string;
  reason: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  recurrence: Recurrence | null;
  scope: "resources" | "groups" | "organization";
  resource_ids: UUID[];
  group_ids: UUID[];
  suppress_notifications: boolean;
  suppress_incidents: boolean;
  responsible_user_id: UUID | null;
  is_active: boolean;
}

export interface MaintenanceWindow extends MaintenanceWindowIn {
  id: UUID;
  created_by_id: UUID | null;
  created_at: ISODate;
  active_now: boolean;
  current_occurrence: { start: ISODate; end: ISODate } | null;
  next_occurrence: { start: ISODate; end: ISODate } | null;
  expired: boolean;
}

// ---------------------------------------------------------------- reports & SLOs

export const REPORT_NAMES = [
  "availability",
  "website-uptime",
  "service-availability",
  "incidents",
  "alerts",
  "utilization",
  "capacity",
  "ssl",
  "log-errors",
  "sla",
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export interface Report {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, JsonValue>[];
  summary: Record<string, JsonValue>;
  start: ISODate | null;
  end: ISODate | null;
  notes: string[];
}

export interface SloStatus {
  target_percent?: number;
  window_days?: number;
  sli_percent?: number | null;
  error_budget_total?: number;
  error_budget_remaining_percent?: number | null;
  bad_events?: number;
  good_events?: number;
  burn_rate_1h?: number | null;
  burn_rate_6h?: number | null;
  status?: "ok" | "at_risk" | "breached" | "no_data" | string;
}

export interface SloIn {
  name: string;
  description: string;
  resource_id: UUID;
  check_id: UUID | null;
  target_percent: number;
  window_days: number;
  burn_rate_alerts: boolean;
  fast_burn_threshold: number;
  slow_burn_threshold: number;
  notification_policy_id: UUID | null;
}

export interface Slo extends SloIn {
  id: UUID;
  last_evaluated_at: ISODate | null;
  last_status: SloStatus;
  created_at: ISODate;
  resource_name: string | null;
}

// ---------------------------------------------------------------- dashboard

export interface StatusBlock {
  total: number;
  healthy: number;
  warning: number;
  critical: number;
  unreachable: number;
  unknown: number;
  maintenance: number;
}

export interface DashboardSummary {
  generated_at: ISODate;
  servers: StatusBlock;
  websites: StatusBlock & { down: number; uptime_24h: number | null; avg_response_ms_24h: number | null };
  network_devices: StatusBlock;
  services: StatusBlock;
  incidents: { open: number; critical_open: number; triggered_today: number; notifications_sent_today: number };
  recent_failures: {
    check_id: UUID;
    check: string;
    type: CheckType;
    resource: string;
    kind: ResourceKind;
    resource_id: UUID;
    message: string;
    since: ISODate;
    last_run_at: ISODate | null;
  }[];
  server_overview: {
    id: UUID;
    name: string;
    status: HealthStatus;
    cpu_percent: number | null;
    memory_percent: number | null;
    disk_percent_max: number | null;
    load1: number | null;
    last_metrics_at: ISODate | null;
  }[];
}

export interface DashboardTrends {
  bucket_seconds: number;
  incidents: { ts: ISODate; critical: number; high: number; warning: number; info: number }[];
  availability: { ts: ISODate; uptime_percent: number | null; down: number; unknown: number; avg_ms: number | null }[];
}

export interface DashboardTraffic {
  step: number;
  points: { ts: ISODate; rx_bps: number; tx_bps: number }[];
}

// ---------------------------------------------------------------- system

export interface SystemStatus {
  time: ISODate;
  heartbeats: Record<string, string | null>;
  queue_depths: Record<string, number>;
  ingest_stream_length: number;
  ingest_groups: { group: string; pending: number; lag: number | null }[] | null;
  notifications: { pending: number; failed_24h: number };
  clickhouse_storage: { table: string; rows: number; bytes: number | null; oldest: ISODate | null }[];
}

// ---------------------------------------------------------------- websocket

export type WsEventType =
  | "ready"
  | "incident"
  | "resource_status"
  | "check_state"
  | "metrics"
  | "notification"
  | "logs"
  | "log_tail"
  | "pong";

export interface WsMessage {
  type: WsEventType | string;
  ts?: ISODate;
  data?: unknown;
}
