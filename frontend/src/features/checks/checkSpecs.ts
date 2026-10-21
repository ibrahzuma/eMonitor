/**
 * Field specifications for every check type, mirroring backend/app/monitoring/check_configs.py.
 * `config` keys are returned by the API; `secret` fields are write-only and only ever sent.
 */
import type { Check, CheckIn, CheckType, JsonAssertion, JsonObject, JsonValue, Severity } from "@/types/api";

export type FieldKind = "text" | "number" | "bool" | "select" | "list" | "intlist" | "kv" | "textarea" | "assertions" | "password";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: readonly string[];
  placeholder?: string;
  hint?: string;
  /** Default form value (also the backend default). */
  def?: string | boolean;
  /** Only shown when predicate returns true. */
  when?: (cfg: DraftValues) => boolean;
  min?: number;
  max?: number;
}

export type AssertionDraft = { path: string; op: JsonAssertion["op"]; value: string };
export type DraftValue = string | boolean | [string, string][] | AssertionDraft[];
export type DraftValues = Record<string, DraftValue>;

const host: FieldSpec = { key: "host", label: "Host", kind: "text", required: true, placeholder: "db.internal or 10.0.0.5" };
const port = (def: string): FieldSpec => ({ key: "port", label: "Port", kind: "number", required: true, def, min: 1, max: 65535 });
const latency: FieldSpec = { key: "latency_warning_ms", label: "Latency warning (ms)", kind: "number", hint: "Degraded above this latency" };

export const CONFIG_SPECS: Record<CheckType, FieldSpec[]> = {
  http: [
    { key: "url", label: "URL", kind: "text", required: true, placeholder: "https://example.com/health" },
    { key: "method", label: "Method", kind: "select", options: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], def: "GET" },
    { key: "expected_status", label: "Expected status codes", kind: "list", def: "200-399", hint: "Comma separated: 200, 200-299 or 2xx" },
    { key: "keyword", label: "Keyword", kind: "text", hint: "Text that must appear in the response body" },
    { key: "keyword_absent", label: "Fail if keyword is present", kind: "bool", def: false },
    { key: "keyword_case_sensitive", label: "Case-sensitive keyword", kind: "bool", def: false },
    { key: "headers", label: "Request headers", kind: "kv", hint: "Authorization/Cookie must go into the secret fields" },
    { key: "body", label: "Request body", kind: "textarea", when: (c) => !["GET", "HEAD"].includes(String(c.method ?? "GET")) },
    { key: "expected_headers", label: "Expected response headers (name → regex)", kind: "kv" },
    { key: "json_assertions", label: "JSON assertions", kind: "assertions" },
    { key: "follow_redirects", label: "Follow redirects", kind: "bool", def: true },
    { key: "max_redirects", label: "Max redirects", kind: "number", def: "5", min: 0, max: 10 },
    { key: "verify_tls", label: "Verify TLS certificate", kind: "bool", def: true },
    { key: "ssl_check", label: "Track certificate expiry", kind: "bool", def: true },
    { key: "ssl_alert_days", label: "SSL alert days", kind: "intlist", hint: "e.g. 30, 14, 7 (empty = organization default)" },
    { key: "degraded_threshold_ms", label: "Degraded above (ms)", kind: "number" },
    { key: "ip_version", label: "IP version", kind: "select", options: ["any", "4", "6"], def: "any" },
  ],
  tcp: [
    host,
    port("80"),
    { key: "send", label: "Send", kind: "text", hint: "Optional payload sent after connecting" },
    { key: "expect", label: "Expect", kind: "text", hint: "Optional substring expected in the reply" },
    { key: "use_tls", label: "Use TLS", kind: "bool", def: false },
  ],
  icmp: [
    host,
    { key: "count", label: "Packets", kind: "number", def: "4", min: 1, max: 20 },
    { key: "packet_loss_warning", label: "Packet loss warning (%)", kind: "number", def: "20", min: 0, max: 100 },
    { key: "packet_loss_critical", label: "Packet loss critical (%)", kind: "number", def: "100", min: 0, max: 100 },
    latency,
  ],
  dns: [
    { key: "name", label: "Name", kind: "text", required: true, placeholder: "example.com" },
    { key: "record_type", label: "Record type", kind: "select", options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "SRV", "CAA", "PTR"], def: "A" },
    { key: "nameserver", label: "Nameserver IP", kind: "text", hint: "Empty = system resolver" },
    { key: "expected_values", label: "Expected values", kind: "list", hint: "Comma separated" },
    { key: "match", label: "Match", kind: "select", options: ["any", "all", "exact"], def: "any" },
  ],
  tls: [
    host,
    port("443"),
    { key: "server_name", label: "Server name (SNI)", kind: "text" },
    { key: "ssl_alert_days", label: "SSL alert days", kind: "intlist", hint: "e.g. 30, 14, 7" },
    { key: "fail_on_invalid", label: "Fail on invalid certificate", kind: "bool", def: true },
  ],
  smtp: [
    host,
    port("25"),
    { key: "starttls", label: "STARTTLS", kind: "bool", def: false },
    { key: "ehlo_name", label: "EHLO name", kind: "text", def: "emonitor.local" },
  ],
  ssh: [host, port("22"), { key: "expect_banner", label: "Expected banner prefix", kind: "text", def: "SSH-2.0" }],
  postgres: dbSpecs("5432"),
  mysql: dbSpecs("3306"),
  redis: [
    host,
    port("6379"),
    { key: "tls", label: "TLS", kind: "bool", def: false },
    { key: "db", label: "Database index", kind: "number", def: "0", min: 0, max: 15 },
    { key: "username", label: "Username (ACL)", kind: "text" },
    latency,
  ],
  domain: [
    { key: "domain", label: "Domain", kind: "text", required: true, placeholder: "example.co.tz", hint: "Registered domain (not a subdomain)" },
    { key: "alert_days", label: "Alert days before expiry", kind: "intlist", hint: "e.g. 60, 30, 14, 7, 1 (empty = organization default)" },
  ],
  snmp: [
    host,
    port("161"),
    { key: "version", label: "SNMP version", kind: "select", options: ["1", "2c", "3"], def: "2c" },
    { key: "collect_interfaces", label: "Collect interface statistics", kind: "bool", def: true },
    { key: "max_interfaces", label: "Max interfaces", kind: "number", def: "64", min: 1, max: 512 },
    { key: "v3_username", label: "SNMPv3 username", kind: "text", when: (c) => c.version === "3", required: true },
    { key: "v3_security_level", label: "Security level", kind: "select", options: ["noAuthNoPriv", "authNoPriv", "authPriv"], def: "authPriv", when: (c) => c.version === "3" },
    { key: "v3_auth_protocol", label: "Auth protocol", kind: "select", options: ["none", "md5", "sha", "sha256", "sha512"], def: "sha", when: (c) => c.version === "3" },
    { key: "v3_priv_protocol", label: "Privacy protocol", kind: "select", options: ["none", "des", "aes128", "aes256"], def: "aes128", when: (c) => c.version === "3" },
  ],
};

function dbSpecs(defPort: string): FieldSpec[] {
  return [
    host,
    port(defPort),
    { key: "database", label: "Database", kind: "text" },
    { key: "username", label: "Username", kind: "text" },
    { key: "tls", label: "TLS", kind: "select", options: ["disable", "prefer", "require"], def: "prefer" },
    { key: "query", label: "Query (read-only)", kind: "textarea", hint: "Single SELECT/SHOW/WITH/VALUES/EXPLAIN statement" },
    { key: "expected_value", label: "Expected value", kind: "text", hint: "First column of the first row must equal this" },
    latency,
  ];
}

export const SECRET_SPECS: Partial<Record<CheckType, FieldSpec[]>> = {
  http: [
    { key: "basic_username", label: "Basic auth username", kind: "text" },
    { key: "basic_password", label: "Basic auth password", kind: "password" },
    { key: "bearer_token", label: "Bearer token", kind: "password" },
    { key: "headers", label: "Secret headers (e.g. API keys)", kind: "kv" },
  ],
  postgres: [{ key: "password", label: "Password", kind: "password" }],
  mysql: [{ key: "password", label: "Password", kind: "password" }],
  redis: [{ key: "password", label: "Password", kind: "password" }],
  snmp: [
    { key: "community", label: "Community string", kind: "password", when: (c) => c.version !== "3" },
    { key: "v3_auth_key", label: "SNMPv3 auth key", kind: "password", when: (c) => c.version === "3" },
    { key: "v3_priv_key", label: "SNMPv3 privacy key", kind: "password", when: (c) => c.version === "3" },
  ],
};

export const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  http: "HTTP(S)",
  tcp: "TCP port",
  icmp: "Ping (ICMP)",
  dns: "DNS",
  tls: "TLS certificate",
  smtp: "SMTP",
  ssh: "SSH",
  postgres: "PostgreSQL",
  mysql: "MySQL",
  redis: "Redis",
  snmp: "SNMP",
  domain: "Domain expiry",
};

export interface CheckDraft {
  name: string;
  type: CheckType;
  config: DraftValues;
  secrets: DraftValues;
  interval_seconds: string;
  timeout_seconds: string;
  failure_threshold: string;
  recovery_threshold: string;
  severity: Severity;
  enabled: boolean;
}

function emptyFor(spec: FieldSpec): DraftValue {
  if (spec.kind === "bool") return spec.def === true;
  if (spec.kind === "kv") return [];
  if (spec.kind === "assertions") return [];
  return typeof spec.def === "string" ? spec.def : "";
}

export function defaultCheckDraft(type: CheckType, name?: string): CheckDraft {
  const config: DraftValues = {};
  for (const s of CONFIG_SPECS[type]) config[s.key] = emptyFor(s);
  const secrets: DraftValues = {};
  for (const s of SECRET_SPECS[type] ?? []) secrets[s.key] = emptyFor(s);
  return {
    name: name ?? CHECK_TYPE_LABELS[type],
    type,
    config,
    secrets,
    interval_seconds: type === "domain" ? "43200" : "60",
    timeout_seconds: type === "domain" ? "30" : "10",
    failure_threshold: type === "domain" ? "1" : "2",
    recovery_threshold: "1",
    severity: "critical",
    enabled: true,
  };
}

function valueToDraft(spec: FieldSpec, v: JsonValue | undefined): DraftValue {
  if (v === undefined || v === null) return emptyFor(spec);
  switch (spec.kind) {
    case "bool":
      return v === true;
    case "list":
    case "intlist":
      return Array.isArray(v) ? v.map(String).join(", ") : String(v);
    case "kv":
      return v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v).map(([k, x]) => [k, String(x ?? "")] as [string, string]) : [];
    case "assertions":
      return Array.isArray(v)
        ? v.map((a) => {
            const o = (a ?? {}) as Record<string, JsonValue>;
            return { path: String(o.path ?? ""), op: (o.op as JsonAssertion["op"]) ?? "eq", value: o.value === undefined || o.value === null ? "" : JSON.stringify(o.value) };
          })
        : [];
    default:
      return String(v);
  }
}

export function checkToDraft(check: Check): CheckDraft {
  const d = defaultCheckDraft(check.type, check.name);
  for (const s of CONFIG_SPECS[check.type] ?? []) d.config[s.key] = valueToDraft(s, check.config[s.key]);
  return {
    ...d,
    interval_seconds: String(check.interval_seconds),
    timeout_seconds: String(check.timeout_seconds),
    failure_threshold: String(check.failure_threshold),
    recovery_threshold: String(check.recovery_threshold),
    severity: check.severity,
    enabled: check.enabled,
  };
}

function parseAssertionValue(s: string): JsonValue {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as JsonValue;
  } catch {
    return t;
  }
}

/** Convert form values to API payload. Empty optional values are omitted so backend defaults apply. */
export function valuesToPayload(specs: FieldSpec[], values: DraftValues, errors: Record<string, string>, prefix: string,
  opts: { omitEmptyBool?: boolean } = {}): JsonObject {
  const out: JsonObject = {};
  for (const s of specs) {
    if (s.when && !s.when(values)) continue;
    const v = values[s.key];
    const errKey = `${prefix}${s.key}`;
    switch (s.kind) {
      case "bool":
        if (!opts.omitEmptyBool || v === true) out[s.key] = v === true;
        break;
      case "number": {
        const str = String(v ?? "").trim();
        if (!str) {
          if (s.required) errors[errKey] = `${s.label} is required`;
          break;
        }
        const n = Number(str);
        if (!Number.isFinite(n)) errors[errKey] = `${s.label} must be a number`;
        else if (s.min !== undefined && n < s.min) errors[errKey] = `${s.label} must be ≥ ${s.min}`;
        else if (s.max !== undefined && n > s.max) errors[errKey] = `${s.label} must be ≤ ${s.max}`;
        else out[s.key] = n;
        break;
      }
      case "list": {
        const items = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (items.length) out[s.key] = items;
        else if (s.required) errors[errKey] = `${s.label} is required`;
        break;
      }
      case "intlist": {
        const items = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (!items.length) break;
        const nums = items.map(Number);
        if (nums.some((n) => !Number.isInteger(n) || n < 0)) errors[errKey] = `${s.label} must be whole numbers`;
        else out[s.key] = nums;
        break;
      }
      case "kv": {
        const rec: Record<string, string> = {};
        for (const [k, val] of (v as [string, string][]) ?? []) if (k.trim()) rec[k.trim()] = val;
        if (Object.keys(rec).length) out[s.key] = rec;
        break;
      }
      case "assertions": {
        const list = ((v as AssertionDraft[]) ?? []).filter((a) => a.path.trim());
        if (list.length) {
          out[s.key] = list.map((a) => {
            const o: JsonObject = { path: a.path.trim(), op: a.op };
            if (a.op !== "exists") o.value = parseAssertionValue(a.value);
            return o;
          });
        }
        break;
      }
      default: {
        const str = String(v ?? "").trim();
        if (str) out[s.key] = str;
        else if (s.required) errors[errKey] = `${s.label} is required`;
      }
    }
  }
  return out;
}

export function validateUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "URL must use http or https";
    if (u.username || u.password) return "Credentials in URLs are not allowed; use the auth secret fields";
    return null;
  } catch {
    return "Enter a valid URL (https://…)";
  }
}

export function validateStatusList(v: string): string | null {
  const items = v.split(",").map((x) => x.trim()).filter(Boolean);
  for (const s of items) if (!/^([1-5]\d\d(-[1-5]\d\d)?|[1-5]xx)$/.test(s)) return `Invalid status "${s}" (use 200, 200-299 or 2xx)`;
  return null;
}

export interface DraftResult {
  payload: CheckIn | null;
  errors: Record<string, string>;
}

/** Validate and convert a check draft. Error keys: "name", "config.<key>", "secrets.<key>", "interval_seconds"… */
export function draftToCheckIn(d: CheckDraft): DraftResult {
  const errors: Record<string, string> = {};
  if (!d.name.trim()) errors.name = "Name is required";
  const config = valuesToPayload(CONFIG_SPECS[d.type], d.config, errors, "config.");
  if (d.type === "http") {
    const url = String(d.config.url ?? "").trim();
    if (url) {
      const e = validateUrl(url);
      if (e) errors["config.url"] = e;
    }
    const st = validateStatusList(String(d.config.expected_status ?? ""));
    if (st) errors["config.expected_status"] = st;
  }
  const secretSpecs = SECRET_SPECS[d.type] ?? [];
  const secrets = valuesToPayload(secretSpecs, { ...d.secrets, version: d.config.version ?? "" }, errors, "secrets.", { omitEmptyBool: true });
  const num = (key: "interval_seconds" | "timeout_seconds" | "failure_threshold" | "recovery_threshold", min: number, max: number, label: string) => {
    const n = Number(d[key]);
    if (!d[key].trim() || !Number.isFinite(n)) errors[key] = `${label} is required`;
    else if (n < min || n > max) errors[key] = `${label} must be between ${min} and ${max}`;
    return n;
  };
  const interval = num("interval_seconds", 10, 86400, "Interval");
  const timeout = num("timeout_seconds", 0.1, 120, "Timeout");
  const failure = num("failure_threshold", 1, 100, "Failure threshold");
  const recovery = num("recovery_threshold", 1, 100, "Recovery threshold");
  if (!errors.interval_seconds && !errors.timeout_seconds && timeout >= interval) errors.timeout_seconds = "Timeout must be shorter than the interval";
  if (Object.keys(errors).length) return { payload: null, errors };
  const payload: CheckIn = {
    name: d.name.trim(),
    type: d.type,
    config,
    interval_seconds: interval,
    timeout_seconds: timeout,
    failure_threshold: failure,
    recovery_threshold: recovery,
    severity: d.severity,
    enabled: d.enabled,
  };
  if (Object.keys(secrets).length) payload.secrets = secrets;
  return { payload, errors };
}

/** Map server-side 422 locations (e.g. ["body","checks",0,"config","url"]) onto draft error keys. */
export function serverErrorsForCheck(fieldErrors: Record<string, string>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldErrors)) {
    if (prefix && !k.startsWith(prefix)) continue;
    const rest = prefix ? k.slice(prefix.length) : k;
    if (rest.startsWith("config.") || rest.startsWith("secrets.") || ["name", "interval_seconds", "timeout_seconds",
      "failure_threshold", "recovery_threshold"].includes(rest)) out[rest] = v;
  }
  return out;
}
