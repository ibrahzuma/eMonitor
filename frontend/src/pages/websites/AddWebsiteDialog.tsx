import { Plus, X } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { websitesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { KeyValueEditor, pairsToRecord } from "@/components/common";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { InlineError } from "@/components/ui/states";
import { validateStatusList, validateUrl } from "@/features/checks/checkSpecs";
import { BaseResourceFields, type BaseFieldsState, baseFieldsFrom, baseFieldsPayload } from "@/features/resources/panels";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import { type HttpMethod, type JsonAssertion, type JsonObject, type JsonValue, SEVERITIES, type Severity, type WebsiteCreate } from "@/types/api";

// ---------------------------------------------------------------- add website

type AssertionRow = { path: string; op: JsonAssertion["op"]; value: string };

interface WebsiteForm {
  base: BaseFieldsState;
  url: string;
  kind: "website" | "api";
  method: HttpMethod;
  expected_status: string;
  keyword: string;
  keyword_absent: boolean;
  headers: [string, string][];
  body: string;
  expected_headers: [string, string][];
  json_assertions: AssertionRow[];
  verify_tls: boolean;
  ssl_check: boolean;
  ssl_alert_days: string;
  degraded_threshold_ms: string;
  follow_redirects: boolean;
  interval_seconds: string;
  timeout_seconds: string;
  failure_threshold: string;
  severity: Severity;
  basic_username: string;
  basic_password: string;
  bearer_token: string;
  secret_headers: [string, string][];
}

function initialForm(): WebsiteForm {
  return {
    base: baseFieldsFrom(null),
    url: "",
    kind: "website",
    method: "GET",
    expected_status: "200-399",
    keyword: "",
    keyword_absent: false,
    headers: [],
    body: "",
    expected_headers: [],
    json_assertions: [],
    verify_tls: true,
    ssl_check: true,
    ssl_alert_days: "",
    degraded_threshold_ms: "",
    follow_redirects: true,
    interval_seconds: "60",
    timeout_seconds: "10",
    failure_threshold: "2",
    severity: "critical",
    basic_username: "",
    basic_password: "",
    bearer_token: "",
    secret_headers: [],
  };
}

const METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const OPS: JsonAssertion["op"][] = ["eq", "ne", "exists", "contains", "gt", "lt"];
const FORBIDDEN_HEADERS = ["host", "authorization", "cookie", "proxy-authorization"];

function parseValue(s: string): JsonValue {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as JsonValue;
  } catch {
    return t;
  }
}

/** Validate the form and build the POST /websites payload. Exported for tests. */
export function buildWebsitePayload(f: WebsiteForm): { payload: WebsiteCreate | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.base.name.trim()) errors.name = "Name is required";
  const url = f.url.trim();
  if (!url) errors.url = "URL is required";
  else {
    const e = validateUrl(url);
    if (e) errors.url = e;
  }
  const st = validateStatusList(f.expected_status);
  if (st) errors.expected_status = st;
  const statuses = f.expected_status.split(",").map((s) => s.trim()).filter(Boolean);
  const interval = Number(f.interval_seconds);
  const timeout = Number(f.timeout_seconds);
  const failure = Number(f.failure_threshold);
  if (!Number.isFinite(interval) || interval < 10 || interval > 86400) errors.interval_seconds = "Interval must be between 10 and 86400 seconds";
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60) errors.timeout_seconds = "Timeout must be between 1 and 60 seconds";
  else if (!errors.interval_seconds && timeout >= interval) errors.timeout_seconds = "Timeout must be shorter than the interval";
  if (!Number.isInteger(failure) || failure < 1 || failure > 100) errors.failure_threshold = "Must be between 1 and 100";
  const headers = pairsToRecord(f.headers);
  for (const k of Object.keys(headers)) {
    if (FORBIDDEN_HEADERS.includes(k.toLowerCase())) errors.headers = `Header ${k} must be configured via the credential fields`;
    else if (!/^[A-Za-z0-9-]{1,100}$/.test(k)) errors.headers = `Invalid header name "${k}"`;
  }
  const expectedHeaders = pairsToRecord(f.expected_headers);
  for (const [k, v] of Object.entries(expectedHeaders)) {
    try {
      new RegExp(v);
    } catch {
      errors.expected_headers = `Invalid regex for ${k}`;
    }
  }
  let sslDays: number[] | null = null;
  if (f.ssl_alert_days.trim()) {
    const nums = f.ssl_alert_days.split(",").map((x) => x.trim()).filter(Boolean).map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 365)) errors.ssl_alert_days = "Use whole numbers of days, e.g. 30, 14, 7";
    else sslDays = nums;
  }
  let degraded: number | null = null;
  if (f.degraded_threshold_ms.trim()) {
    const n = Number(f.degraded_threshold_ms);
    if (!Number.isFinite(n) || n <= 0) errors.degraded_threshold_ms = "Must be a positive number";
    else degraded = n;
  }
  const assertions = f.json_assertions.filter((a) => a.path.trim()).map((a) => {
    const o: JsonAssertion = { path: a.path.trim(), op: a.op };
    if (a.op !== "exists") o.value = parseValue(a.value);
    return o;
  });
  if (Object.keys(errors).length) return { payload: null, errors };

  const secrets: JsonObject = {};
  if (f.basic_username.trim()) secrets.basic_username = f.basic_username.trim();
  if (f.basic_password) secrets.basic_password = f.basic_password;
  if (f.bearer_token) secrets.bearer_token = f.bearer_token;
  const secretHeaders = pairsToRecord(f.secret_headers);
  if (Object.keys(secretHeaders).length) secrets.headers = secretHeaders;

  const payload: WebsiteCreate = {
    ...baseFieldsPayload(f.base),
    url,
    kind: f.kind,
    method: f.method,
    expected_status: statuses.length ? statuses : ["200-399"],
    interval_seconds: interval,
    timeout_seconds: timeout,
    keyword: f.keyword.trim() || null,
    keyword_absent: f.keyword_absent,
    headers,
    body: ["GET", "HEAD"].includes(f.method) || !f.body ? null : f.body,
    expected_headers: expectedHeaders,
    json_assertions: assertions,
    verify_tls: f.verify_tls,
    ssl_check: f.ssl_check,
    ssl_alert_days: sslDays,
    degraded_threshold_ms: degraded,
    follow_redirects: f.follow_redirects,
    failure_threshold: failure,
    severity: f.severity,
  };
  if (Object.keys(secrets).length) payload.secrets = secrets;
  return { payload, errors };
}

export function AddWebsiteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [f, setF] = React.useState<WebsiteForm>(initialForm);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (open) {
      setF(initialForm());
      setErrors({});
      setFormError(null);
    }
  }, [open]);
  const set = <K extends keyof WebsiteForm>(k: K, v: WebsiteForm[K]) => setF((p) => ({ ...p, [k]: v }));

  const create = useApiMutation({
    mutationFn: (p: WebsiteCreate) => websitesApi.create(p),
    invalidate: [qk.resources, qk.dashboard],
    success: (r) => `Website “${r.name}” added`,
    errorTitle: false,
    onSuccess: (r) => {
      onOpenChange(false);
      navigate(`/websites/${r.id}`);
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      const mapped: Record<string, string> = {};
      for (const [k, v] of Object.entries(fe)) mapped[k.replace(/^config\./, "")] = v;
      setErrors(mapped);
      setFormError(e);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const { payload, errors: errs } = buildWebsitePayload(f);
    setErrors(errs);
    if (payload) create.mutate(payload);
  };

  const showBody = !["GET", "HEAD"].includes(f.method);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add website or API</DialogTitle>
          <DialogDescription>An HTTP check runs from the monitoring workers at the chosen interval.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="flex flex-col gap-5">
            {formError !== null && <InlineError error={formError} />}
            <section className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
                <Field label="URL" htmlFor="web-url" error={errors.url} required>
                  <Input id="web-url" value={f.url} placeholder="https://example.com/health" onChange={(e) => set("url", e.target.value)} />
                </Field>
                <Field label="Method" htmlFor="web-method">
                  <NativeSelect id="web-method" value={f.method} onChange={(e) => set("method", e.target.value as HttpMethod)} className="w-28">
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </NativeSelect>
                </Field>
                <Field label="Kind" htmlFor="web-kind">
                  <NativeSelect id="web-kind" value={f.kind} onChange={(e) => set("kind", e.target.value as "website" | "api")} className="w-28">
                    <option value="website">Website</option>
                    <option value="api">API</option>
                  </NativeSelect>
                </Field>
              </div>
              <BaseResourceFields value={f.base} onChange={(b) => set("base", b)} errors={errors} idPrefix="web" />
            </section>

            <fieldset className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Assertions</legend>
              <Field label="Expected status codes" htmlFor="web-status" error={errors.expected_status} hint="Comma separated: 200, 200-299 or 2xx">
                <Input id="web-status" value={f.expected_status} onChange={(e) => set("expected_status", e.target.value)} />
              </Field>
              <Field label="Keyword" htmlFor="web-keyword" hint="Text that must appear in the body">
                <Input id="web-keyword" value={f.keyword} onChange={(e) => set("keyword", e.target.value)} />
              </Field>
              <div className="sm:col-span-2">
                <CheckboxField id="web-kw-absent" label="Fail if the keyword is present" checked={f.keyword_absent} onCheckedChange={(v) => set("keyword_absent", v)} />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium">Expected response headers (name → regex)</span>
                <KeyValueEditor idPrefix="web-exph" value={f.expected_headers} onChange={(v) => set("expected_headers", v)} valuePlaceholder="Regex" />
                {errors.expected_headers && <p role="alert" className="text-xs text-destructive">{errors.expected_headers}</p>}
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-xs font-medium">JSON assertions</span>
                {f.json_assertions.map((a, i) => (
                  <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                    <Input aria-label={`Assertion ${i + 1} path`} placeholder="data.status" value={a.path}
                      onChange={(e) => set("json_assertions", f.json_assertions.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
                    <NativeSelect aria-label={`Assertion ${i + 1} operator`} value={a.op} className="w-24"
                      onChange={(e) => set("json_assertions", f.json_assertions.map((x, j) => (j === i ? { ...x, op: e.target.value as JsonAssertion["op"] } : x)))}>
                      {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </NativeSelect>
                    <Input aria-label={`Assertion ${i + 1} value`} placeholder='"ok" or 200' value={a.value} disabled={a.op === "exists"}
                      onChange={(e) => set("json_assertions", f.json_assertions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove assertion ${i + 1}`}
                      onClick={() => set("json_assertions", f.json_assertions.filter((_, j) => j !== i))}><X /></Button>
                  </div>
                ))}
                <div>
                  <Button variant="outline" size="sm" onClick={() => set("json_assertions", [...f.json_assertions, { path: "", op: "eq", value: "" }])}>
                    <Plus /> Add assertion
                  </Button>
                </div>
              </div>
            </fieldset>

            <fieldset className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Request</legend>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium">Request headers</span>
                <span className="text-xs text-muted-foreground">Authorization / Cookie headers belong in the credential section.</span>
                <KeyValueEditor idPrefix="web-hdr" value={f.headers} onChange={(v) => set("headers", v)} />
                {errors.headers && <p role="alert" className="text-xs text-destructive">{errors.headers}</p>}
              </div>
              {showBody && (
                <Field label="Request body" htmlFor="web-body" className="sm:col-span-2">
                  <Textarea id="web-body" value={f.body} onChange={(e) => set("body", e.target.value)} className="font-mono text-xs" />
                </Field>
              )}
              <CheckboxField id="web-follow" label="Follow redirects" checked={f.follow_redirects} onCheckedChange={(v) => set("follow_redirects", v)} />
              <CheckboxField id="web-verify" label="Verify TLS certificate" checked={f.verify_tls} onCheckedChange={(v) => set("verify_tls", v)} />
              <CheckboxField id="web-ssl" label="Track certificate expiry" checked={f.ssl_check} onCheckedChange={(v) => set("ssl_check", v)} />
              <Field label="SSL alert days" htmlFor="web-ssl-days" error={errors.ssl_alert_days} hint="e.g. 30, 14, 7 — empty = organization default">
                <Input id="web-ssl-days" value={f.ssl_alert_days} onChange={(e) => set("ssl_alert_days", e.target.value)} />
              </Field>
            </fieldset>

            <fieldset className="grid grid-cols-2 gap-3 rounded-md border p-3 sm:grid-cols-5">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Schedule & alerting</legend>
              <Field label="Interval (s)" htmlFor="web-interval" error={errors.interval_seconds}>
                <Input id="web-interval" type="number" min={10} value={f.interval_seconds} onChange={(e) => set("interval_seconds", e.target.value)} />
              </Field>
              <Field label="Timeout (s)" htmlFor="web-timeout" error={errors.timeout_seconds}>
                <Input id="web-timeout" type="number" min={1} max={60} value={f.timeout_seconds} onChange={(e) => set("timeout_seconds", e.target.value)} />
              </Field>
              <Field label="Failures to alert" htmlFor="web-fail" error={errors.failure_threshold}>
                <Input id="web-fail" type="number" min={1} value={f.failure_threshold} onChange={(e) => set("failure_threshold", e.target.value)} />
              </Field>
              <Field label="Degraded above (ms)" htmlFor="web-degraded" error={errors.degraded_threshold_ms}>
                <Input id="web-degraded" type="number" value={f.degraded_threshold_ms} onChange={(e) => set("degraded_threshold_ms", e.target.value)} />
              </Field>
              <Field label="Severity" htmlFor="web-sev">
                <NativeSelect id="web-sev" value={f.severity} onChange={(e) => set("severity", e.target.value as Severity)}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </NativeSelect>
              </Field>
            </fieldset>

            <fieldset className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Credentials (write-only)</legend>
              <p className="text-xs text-muted-foreground sm:col-span-2">Stored encrypted and never displayed again.</p>
              <Field label="Basic auth username" htmlFor="web-bu">
                <Input id="web-bu" autoComplete="off" value={f.basic_username} onChange={(e) => set("basic_username", e.target.value)} />
              </Field>
              <Field label="Basic auth password" htmlFor="web-bp">
                <Input id="web-bp" type="password" autoComplete="new-password" value={f.basic_password} onChange={(e) => set("basic_password", e.target.value)} />
              </Field>
              <Field label="Bearer token" htmlFor="web-bt" className="sm:col-span-2">
                <Input id="web-bt" type="password" autoComplete="new-password" value={f.bearer_token} onChange={(e) => set("bearer_token", e.target.value)} />
              </Field>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium">Secret headers (e.g. API keys)</span>
                <KeyValueEditor idPrefix="web-sh" value={f.secret_headers} onChange={(v) => set("secret_headers", v)} secret />
              </div>
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Add website</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
