import { PERMISSIONS, type Check, type Me, type Permission, type Resource, type Incident, type DashboardSummary } from "@/types/api";

export const ORG_ID = "9a235371-50b9-4347-a1c8-8a6141a5ee8a";
export const ORG2_ID = "fd9c1d79-bbd9-4ba7-8335-fb01ef93b21c";
export const USER_ID = "fc233792-85ee-40f2-abcb-978dcb1b43ee";

export function makeMe(perms: readonly Permission[] = PERMISSIONS, overrides: Partial<Me["user"]> = {}): Me {
  return {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      full_name: "Administrator",
      timezone: "UTC",
      is_superadmin: true,
      totp_enabled: false,
      telegram_chat_id: null,
      last_login_at: "2026-10-21T06:55:01Z",
      ...overrides,
    },
    memberships: [
      { organization_id: ORG_ID, organization_name: "Acme Corp", organization_slug: "acme", role: "super_admin" },
      { organization_id: ORG2_ID, organization_name: "Demo Organization", organization_slug: "demo", role: "super_admin" },
    ],
    permissions: { [ORG_ID]: [...perms], [ORG2_ID]: [...perms] },
  };
}

export function makeCheck(overrides: Partial<Check> = {}): Check {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    resource_id: "r0000000-0000-4000-8000-000000000001",
    name: "HTTP",
    type: "http",
    config: { url: "https://example.com/", method: "GET", expected_status: ["200-399"], ssl_check: true },
    has_secrets: false,
    interval_seconds: 60,
    timeout_seconds: 10,
    failure_threshold: 2,
    recovery_threshold: 1,
    severity: "critical",
    enabled: true,
    next_run_at: "2026-10-21T07:00:00Z",
    last_run_at: "2026-10-21T06:59:00Z",
    last_outcome: "up",
    last_message: "HTTP 200 in 120 ms",
    last_latency_ms: 120,
    last_details: { certificate: { days_remaining: 42 } },
    consecutive_failures: 0,
    consecutive_successes: 5,
    state: "healthy",
    state_changed_at: "2026-10-21T06:00:00Z",
    created_at: "2026-10-20T06:00:00Z",
    ...overrides,
  };
}

export function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: "r0000000-0000-4000-8000-000000000001",
    kind: "server",
    name: "web-01",
    description: "",
    address: "10.0.0.1",
    environment: "production",
    location: "",
    business_owner: "",
    group_id: null,
    team_id: null,
    tags: [],
    custom_fields: {},
    attributes: {},
    status: "healthy",
    status_reason: "",
    status_changed_at: "2026-10-21T06:00:00Z",
    is_paused: false,
    created_at: "2026-10-20T06:00:00Z",
    updated_at: "2026-10-21T06:00:00Z",
    server: null,
    agent: null,
    checks: [],
    open_incidents: 0,
    uptime_24h: null,
    ...overrides,
  };
}

export function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "i0000000-0000-4000-8000-000000000001",
    number: 42,
    title: "Website down: Example.com",
    description: "",
    severity: "critical",
    status: "triggered",
    source: "check",
    source_id: "",
    dedup_key: "check:1",
    resource_id: null,
    team_id: null,
    assignee_id: null,
    alert_rule_id: null,
    trigger_condition: "HTTP check failed 2 times",
    evidence: { status: 503 },
    first_detected_at: "2026-10-21T06:00:00Z",
    last_detected_at: "2026-10-21T06:30:00Z",
    acknowledged_at: null,
    acknowledged_by_id: null,
    resolved_at: null,
    resolved_by_id: null,
    resolution: "",
    occurrence_count: 3,
    reopen_count: 0,
    in_maintenance: false,
    escalation_step: 0,
    created_at: "2026-10-21T06:00:00Z",
    group_key: "",
    duration_seconds: 1800,
    resource_name: null,
    resource_kind: null,
    assignee_name: null,
    ...overrides,
  };
}

const block = (o: Partial<DashboardSummary["servers"]> = {}) => ({
  total: 0, healthy: 0, warning: 0, critical: 0, unreachable: 0, unknown: 0, maintenance: 0, ...o,
});

export function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    generated_at: "2026-10-21T07:00:00Z",
    servers: block({ total: 12, healthy: 9, warning: 1, critical: 2 }),
    websites: { ...block({ total: 4, healthy: 3, critical: 1 }), down: 1, uptime_24h: 99.5, avg_response_ms_24h: 245.3 },
    network_devices: block({ total: 2, healthy: 2 }),
    services: block({ total: 3, healthy: 3 }),
    incidents: { open: 5, critical_open: 2, triggered_today: 7, notifications_sent_today: 11 },
    recent_failures: [],
    server_overview: [],
    ...overrides,
  };
}
