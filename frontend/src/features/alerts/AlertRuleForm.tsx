import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { ApiError } from "@/api/client";
import { alertsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { TagInput } from "@/components/common";
import { CheckPicker, GroupPicker, MultiSelect, PolicySelect, ResourcePicker } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/controls";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { InlineError } from "@/components/ui/states";
import {
  ALERT_RULE_TYPES,
  type AlertRule,
  type AlertRuleIn,
  type AlertRuleType,
  ENVIRONMENTS,
  type JsonObject,
  type JsonValue,
  LOG_SEVERITIES,
  RESOURCE_KINDS,
  type RuleTarget,
  SEVERITIES,
  type Severity,
} from "@/types/api";
import { humanize } from "@/utils/format";
import { KIND_LABELS } from "@/utils/status";

// ---------------------------------------------------------------- condition field specs (backend/app/alerts/rules.py)

export type CondFieldKind = "text" | "number" | "select" | "bool" | "list" | "severities" | "rules";

export interface CondField {
  key: string;
  label: string;
  kind: CondFieldKind;
  options?: readonly string[];
  required?: boolean;
  def?: string | boolean | string[];
  hint?: string;
  min?: number;
  max?: number;
  optional?: boolean;
}

const OPERATORS = ["gt", "gte", "lt", "lte"] as const;
const windowField = (def: string, min: number): CondField => ({
  key: "window_seconds", label: "Window (seconds)", kind: "number", def, min, max: 86400, required: true,
});

export const CONDITION_FIELDS: Record<AlertRuleType, CondField[]> = {
  metric_threshold: [
    { key: "metric", label: "Metric", kind: "text", required: true, def: "cpu_percent", hint: "e.g. cpu_percent, memory_percent, disk_percent, load1" },
    { key: "instance", label: "Instance", kind: "text", optional: true, hint: "Empty = evaluate every instance (disk mount, interface…) separately" },
    { key: "aggregation", label: "Aggregation", kind: "select", options: ["avg", "min", "max", "p95", "p99", "last", "sum", "count"], def: "avg" },
    { key: "operator", label: "Operator", kind: "select", options: OPERATORS, def: "gt" },
    { key: "threshold", label: "Threshold", kind: "number", required: true, def: "90" },
    windowField("300", 30),
  ],
  response_time: [
    { key: "aggregation", label: "Aggregation", kind: "select", options: ["avg", "p95", "p99", "max"], def: "avg" },
    { key: "operator", label: "Operator", kind: "select", options: OPERATORS, def: "gt" },
    { key: "threshold_ms", label: "Threshold (ms)", kind: "number", required: true, def: "1000", min: 0.001 },
    windowField("300", 60),
  ],
  consecutive_failures: [
    { key: "failures", label: "Consecutive failures", kind: "number", required: true, def: "3", min: 1, max: 1000 },
  ],
  website_down: [],
  ssl_expiry: [
    { key: "days", label: "Days before expiry", kind: "number", required: true, def: "14", min: 0, max: 365 },
  ],
  log_pattern: [
    { key: "query", label: "Query", kind: "text", def: "", hint: "Full-text search; quote phrases" },
    { key: "severities", label: "Severities", kind: "severities", def: [] },
    { key: "min_severity", label: "Minimum severity", kind: "select", options: ["", ...LOG_SEVERITIES], def: "", optional: true },
    { key: "applications", label: "Applications", kind: "list", def: [] },
    { key: "services", label: "Services", kind: "list", def: [] },
    { key: "operator", label: "Operator", kind: "select", options: OPERATORS, def: "gte" },
    { key: "threshold", label: "Matching events threshold", kind: "number", required: true, def: "1", min: 0 },
    windowField("300", 60),
    { key: "per_resource", label: "Evaluate per resource", kind: "bool", def: false },
  ],
  error_rate: [
    { key: "source", label: "Source", kind: "select", options: ["logs", "checks"], def: "logs" },
    { key: "threshold_percent", label: "Error rate threshold (%)", kind: "number", required: true, def: "5", min: 0.001, max: 100 },
    { key: "min_events", label: "Minimum events", kind: "number", required: true, def: "10", min: 1 },
    windowField("300", 60),
    { key: "applications", label: "Applications", kind: "list", def: [] },
  ],
  missing_telemetry: [
    { key: "metric", label: "Metric", kind: "text", required: true, def: "cpu_percent" },
    windowField("300", 60),
  ],
  agent_disconnected: [
    { key: "seconds", label: "Disconnected for (seconds)", kind: "number", required: true, def: "300", min: 30, max: 86400 },
  ],
  composite: [
    { key: "operator", label: "Combine with", kind: "select", options: ["and", "or"], def: "and" },
    { key: "rule_ids", label: "Rules", kind: "rules", def: [], required: true, hint: "Select 2 to 10 rules" },
  ],
};

export const RULE_TYPE_LABELS: Record<AlertRuleType, string> = {
  metric_threshold: "Metric threshold",
  response_time: "Response time",
  consecutive_failures: "Consecutive check failures",
  website_down: "Website down",
  ssl_expiry: "SSL certificate expiry",
  log_pattern: "Log pattern",
  error_rate: "Error rate",
  missing_telemetry: "Missing telemetry",
  agent_disconnected: "Agent disconnected",
  composite: "Composite (combine rules)",
};

export type CondDraftValue = string | boolean | string[];
export type CondDraft = Record<string, CondDraftValue>;

export function defaultCondition(type: AlertRuleType): CondDraft {
  const out: CondDraft = {};
  for (const f of CONDITION_FIELDS[type]) {
    out[f.key] = f.def ?? (f.kind === "bool" ? false : f.kind === "list" || f.kind === "severities" || f.kind === "rules" ? [] : "");
  }
  return out;
}

export function conditionFromRule(type: AlertRuleType, cond: JsonObject): CondDraft {
  const out = defaultCondition(type);
  for (const f of CONDITION_FIELDS[type]) {
    const v = cond[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === "bool") out[f.key] = v === true;
    else if (Array.isArray(v)) out[f.key] = v.map(String);
    else out[f.key] = String(v);
  }
  return out;
}

/** Convert the draft to the API condition object; validation errors are keyed "condition.<key>". */
export function conditionToPayload(type: AlertRuleType, draft: CondDraft, errors: Record<string, string> = {}): JsonObject {
  const out: JsonObject = {};
  for (const f of CONDITION_FIELDS[type]) {
    const v = draft[f.key];
    const ek = `condition.${f.key}`;
    switch (f.kind) {
      case "bool":
        out[f.key] = v === true;
        break;
      case "number": {
        const s = String(v ?? "").trim();
        if (!s) {
          if (f.required) errors[ek] = `${f.label} is required`;
          break;
        }
        const n = Number(s);
        if (!Number.isFinite(n)) errors[ek] = `${f.label} must be a number`;
        else if (f.min !== undefined && n < f.min) errors[ek] = `${f.label} must be ≥ ${f.min}`;
        else if (f.max !== undefined && n > f.max) errors[ek] = `${f.label} must be ≤ ${f.max}`;
        else out[f.key] = n;
        break;
      }
      case "list":
      case "severities":
        out[f.key] = Array.isArray(v) ? v : [];
        break;
      case "rules": {
        const ids = Array.isArray(v) ? v : [];
        if (ids.length < 2) errors[ek] = "Select at least 2 rules";
        else if (ids.length > 10) errors[ek] = "Select at most 10 rules";
        out[f.key] = ids;
        break;
      }
      default: {
        const s = String(v ?? "").trim();
        if (s) out[f.key] = s;
        else if (f.required) errors[ek] = `${f.label} is required`;
        else if (!f.optional && f.key === "query") out[f.key] = "";
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- form state

export interface RuleDraft {
  name: string;
  description: string;
  rule_type: AlertRuleType;
  condition: CondDraft;
  target: RuleTarget;
  severity: Severity;
  evaluation_interval_seconds: string;
  consecutive_breaches: string;
  recovery_consecutive: string;
  cooldown_seconds: string;
  suppress_in_maintenance: boolean;
  auto_resolve: boolean;
  notification_policy_id: string;
  enabled: boolean;
}

const emptyTarget = (): RuleTarget => ({ resource_ids: [], group_ids: [], check_ids: [], tags: [], kinds: [], environments: [] });

export function ruleDraft(rule?: AlertRule | null, type: AlertRuleType = "metric_threshold"): RuleDraft {
  if (!rule) {
    return {
      name: "", description: "", rule_type: type, condition: defaultCondition(type), target: emptyTarget(), severity: "warning",
      evaluation_interval_seconds: "60", consecutive_breaches: "1", recovery_consecutive: "1", cooldown_seconds: "300",
      suppress_in_maintenance: true, auto_resolve: true, notification_policy_id: "", enabled: true,
    };
  }
  const rt = rule.rule_type;
  return {
    name: rule.name,
    description: rule.description,
    rule_type: rt,
    condition: conditionFromRule(rt, rule.condition),
    target: { ...emptyTarget(), ...rule.target },
    severity: rule.severity,
    evaluation_interval_seconds: String(rule.evaluation_interval_seconds),
    consecutive_breaches: String(rule.consecutive_breaches),
    recovery_consecutive: String(rule.recovery_consecutive),
    cooldown_seconds: String(rule.cooldown_seconds),
    suppress_in_maintenance: rule.suppress_in_maintenance,
    auto_resolve: rule.auto_resolve,
    notification_policy_id: rule.notification_policy_id ?? "",
    enabled: rule.enabled,
  };
}

/** Build the PUT/POST body from a full rule (used e.g. for the enabled toggle). */
export function ruleToPayload(rule: AlertRule, patch: Partial<AlertRuleIn> = {}): AlertRuleIn {
  return {
    name: rule.name,
    description: rule.description,
    rule_type: rule.rule_type,
    target: { ...emptyTarget(), ...rule.target },
    condition: rule.condition,
    severity: rule.severity,
    evaluation_interval_seconds: rule.evaluation_interval_seconds,
    consecutive_breaches: rule.consecutive_breaches,
    recovery_consecutive: rule.recovery_consecutive,
    cooldown_seconds: rule.cooldown_seconds,
    suppress_in_maintenance: rule.suppress_in_maintenance,
    auto_resolve: rule.auto_resolve,
    notification_policy_id: rule.notification_policy_id,
    enabled: rule.enabled,
    ...patch,
  };
}

export function draftToRule(d: RuleDraft): { payload: AlertRuleIn | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!d.name.trim()) errors.name = "Name is required";
  const condition = conditionToPayload(d.rule_type, d.condition, errors);
  const int = (key: keyof RuleDraft, min: number, max: number, label: string): number => {
    const n = Number(d[key]);
    if (!String(d[key]).trim() || !Number.isInteger(n)) errors[key] = `${label} must be a whole number`;
    else if (n < min || n > max) errors[key] = `${label} must be between ${min} and ${max}`;
    return n;
  };
  const evaluation = int("evaluation_interval_seconds", 15, 86400, "Evaluation interval");
  const breaches = int("consecutive_breaches", 1, 100, "Consecutive breaches");
  const recovery = int("recovery_consecutive", 1, 100, "Recovery evaluations");
  const cooldown = int("cooldown_seconds", 0, 86400, "Cooldown");
  if (Object.keys(errors).length) return { payload: null, errors };
  return {
    payload: {
      name: d.name.trim(),
      description: d.description,
      rule_type: d.rule_type,
      target: d.target,
      condition,
      severity: d.severity,
      evaluation_interval_seconds: evaluation,
      consecutive_breaches: breaches,
      recovery_consecutive: recovery,
      cooldown_seconds: cooldown,
      suppress_in_maintenance: d.suppress_in_maintenance,
      auto_resolve: d.auto_resolve,
      notification_policy_id: d.notification_policy_id || null,
      enabled: d.enabled,
    },
    errors,
  };
}

/** Map backend 422 details to form error keys ("condition.threshold", "name"…). */
export function ruleServerErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422) return {};
  const out: Record<string, string> = {};
  for (const d of err.validationDetails) {
    const loc = (d.loc ?? []).filter((p) => p !== "body").map(String);
    if (!loc.length || !d.msg) continue;
    const msg = d.msg.replace(/^Value error, /, "");
    if (loc[0] === "condition" || loc[0] === "target") out[`${loc[0]}.${loc[1] ?? ""}`] = msg;
    else if (loc.length === 1 && CONDITION_KEYS.has(loc[0]) && !TOP_KEYS.has(loc[0])) out[`condition.${loc[0]}`] = msg;
    else out[loc[0]] = msg;
  }
  return out;
}

const TOP_KEYS = new Set(["name", "description", "rule_type", "severity", "evaluation_interval_seconds", "consecutive_breaches",
  "recovery_consecutive", "cooldown_seconds", "notification_policy_id"]);
const CONDITION_KEYS = new Set(Object.values(CONDITION_FIELDS).flat().map((f) => f.key));

/** Readable one-line summary of a rule condition. */
export function describeCondition(type: AlertRuleType, c: JsonObject): string {
  const g = (k: string): string => {
    const v: JsonValue | undefined = c[k];
    return v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
  };
  const op: Record<string, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
  switch (type) {
    case "metric_threshold":
      return `${g("aggregation")}(${g("metric")}${g("instance") ? `{${g("instance")}}` : ""}) ${op[g("operator")] ?? g("operator")} ${g("threshold")} over ${g("window_seconds")}s`;
    case "response_time":
      return `${g("aggregation")} response time ${op[g("operator")] ?? g("operator")} ${g("threshold_ms")} ms over ${g("window_seconds")}s`;
    case "consecutive_failures":
      return `${g("failures")} consecutive check failures`;
    case "website_down":
      return "Website/API check reports down";
    case "ssl_expiry":
      return `Certificate expires within ${g("days")} days`;
    case "log_pattern":
      return `count(logs${g("query") ? ` matching "${g("query")}"` : ""}${g("severities") ? ` severity in [${g("severities")}]` : ""}${g("min_severity") ? ` ≥ ${g("min_severity")}` : ""}) ${op[g("operator")] ?? g("operator")} ${g("threshold")} in ${g("window_seconds")}s${c.per_resource ? " per resource" : ""}`;
    case "error_rate":
      return `${g("source")} error rate > ${g("threshold_percent")}% (min ${g("min_events")} events) over ${g("window_seconds")}s`;
    case "missing_telemetry":
      return `No ${g("metric")} samples for ${g("window_seconds")}s`;
    case "agent_disconnected":
      return `Agent silent for ${g("seconds")}s`;
    case "composite":
      return `${(Array.isArray(c.rule_ids) ? c.rule_ids.length : 0)} rules combined with ${g("operator").toUpperCase()}`;
    default:
      return JSON.stringify(c);
  }
}

// ---------------------------------------------------------------- component

function ConditionFields({ type, value, onChange, errors, ruleId }: {
  type: AlertRuleType;
  value: CondDraft;
  onChange: (v: CondDraft) => void;
  errors: Record<string, string>;
  ruleId?: string;
}) {
  const fields = CONDITION_FIELDS[type];
  const rules = useQuery({ queryKey: qk.alertRules, queryFn: alertsApi.list, enabled: type === "composite" });
  const set = (k: string, v: CondDraftValue) => onChange({ ...value, [k]: v });
  if (!fields.length) {
    return <p className="text-sm text-muted-foreground">Fires when a targeted website or API check is down (after its failure threshold). No extra condition settings.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        const id = `rule-cond-${f.key}`;
        const err = errors[`condition.${f.key}`];
        const v = value[f.key];
        if (f.kind === "bool") {
          return (
            <div key={f.key} className="flex items-end pb-1">
              <CheckboxField id={id} label={f.label} checked={v === true} onCheckedChange={(c) => set(f.key, c)} />
            </div>
          );
        }
        if (f.kind === "list") {
          return (
            <Field key={f.key} label={f.label} htmlFor={id} error={err} hint={f.hint}>
              <TagInput id={id} value={Array.isArray(v) ? v : []} onChange={(x) => set(f.key, x)} />
            </Field>
          );
        }
        if (f.kind === "severities" || f.kind === "rules") {
          const options = f.kind === "severities"
            ? LOG_SEVERITIES.map((s) => ({ value: s, label: s }))
            : (rules.data ?? []).filter((r) => r.id !== ruleId).map((r) => ({ value: r.id, label: r.name, hint: RULE_TYPE_LABELS[r.rule_type] }));
          return (
            <div key={f.key} className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor={id} className="text-xs font-medium">{f.label}{f.required && <span className="text-destructive"> *</span>}</label>
              <MultiSelect id={id} ariaLabel={f.label} value={Array.isArray(v) ? v : []} onChange={(x) => set(f.key, x)}
                options={options} loading={f.kind === "rules" && rules.isLoading} emptyText={f.kind === "rules" ? "No other rules exist yet" : undefined} />
              {f.hint && !err && <span className="text-xs text-muted-foreground">{f.hint}</span>}
              {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
            </div>
          );
        }
        return (
          <Field key={f.key} label={f.label} htmlFor={id} error={err} hint={f.hint} required={f.required}>
            {f.kind === "select" ? (
              <NativeSelect id={id} value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o === "" ? "— Any —" : o}</option>)}
              </NativeSelect>
            ) : (
              <Input id={id} type={f.kind === "number" ? "number" : "text"} value={String(v ?? "")} min={f.min} max={f.max}
                step={f.kind === "number" ? "any" : undefined} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

export function AlertRuleForm({ rule, onSubmit, onCancel, submitting, error }: {
  rule?: AlertRule | null;
  onSubmit: (payload: AlertRuleIn) => void;
  onCancel?: () => void;
  submitting?: boolean;
  /** Last submit error (422 details are mapped to fields). */
  error?: unknown;
}) {
  const [d, setD] = React.useState<RuleDraft>(() => ruleDraft(rule));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    setD(ruleDraft(rule));
    setErrors({});
  }, [rule]);
  React.useEffect(() => {
    const se = ruleServerErrors(error);
    if (Object.keys(se).length) setErrors((p) => ({ ...p, ...se }));
  }, [error]);

  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const setTarget = <K extends keyof RuleTarget>(k: K, v: RuleTarget[K]) => setD((p) => ({ ...p, target: { ...p.target, [k]: v } }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { payload, errors: errs } = draftToRule(d);
    setErrors(errs);
    if (payload) onSubmit(payload);
  };

  const editing = Boolean(rule);
  const hasFieldErrors = Object.keys(errors).length > 0;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate aria-label="Alert rule form">
      {error !== undefined && error !== null && !hasFieldErrors && <InlineError error={error} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="rule-name" error={errors.name} required>
          <Input id="rule-name" value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={200} />
        </Field>
        <Field label="Rule type" htmlFor="rule-type" error={errors.rule_type} hint={editing ? "The type cannot be changed after creation" : undefined}>
          <NativeSelect id="rule-type" value={d.rule_type} disabled={editing}
            onChange={(e) => {
              const t = e.target.value as AlertRuleType;
              setD((p) => ({ ...p, rule_type: t, condition: defaultCondition(t) }));
              setErrors({});
            }}>
            {ALERT_RULE_TYPES.map((t) => <option key={t} value={t}>{RULE_TYPE_LABELS[t]}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Description" htmlFor="rule-desc" className="sm:col-span-2">
          <Textarea id="rule-desc" rows={2} value={d.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </div>

      <fieldset className="rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold text-muted-foreground">Condition — {RULE_TYPE_LABELS[d.rule_type]}</legend>
        <ConditionFields type={d.rule_type} value={d.condition} onChange={(c) => set("condition", c)} errors={errors} ruleId={rule?.id} />
      </fieldset>

      <fieldset className="rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold text-muted-foreground">Targets</legend>
        <p className="mb-2 text-xs text-muted-foreground">Leave all empty to evaluate every applicable resource in the organization.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="rule-t-res" className="text-xs font-medium">Resources</label>
            <ResourcePicker id="rule-t-res" ariaLabel="Target resources" value={d.target.resource_ids} onChange={(v) => setTarget("resource_ids", v)} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rule-t-groups" className="text-xs font-medium">Groups</label>
            <GroupPicker id="rule-t-groups" value={d.target.group_ids} onChange={(v) => setTarget("group_ids", v)} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rule-t-checks" className="text-xs font-medium">Checks</label>
            <CheckPicker id="rule-t-checks" value={d.target.check_ids} onChange={(v) => setTarget("check_ids", v)} />
          </div>
          <Field label="Tags" htmlFor="rule-t-tags">
            <TagInput id="rule-t-tags" value={d.target.tags} onChange={(v) => setTarget("tags", v)} />
          </Field>
          <div className="flex flex-col gap-1">
            <label htmlFor="rule-t-kinds" className="text-xs font-medium">Resource kinds</label>
            <MultiSelect id="rule-t-kinds" ariaLabel="Target kinds" value={d.target.kinds} onChange={(v) => setTarget("kinds", v)}
              options={RESOURCE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k }))} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="rule-t-envs" className="text-xs font-medium">Environments</label>
            <MultiSelect id="rule-t-envs" ariaLabel="Target environments" value={d.target.environments} onChange={(v) => setTarget("environments", v)}
              options={ENVIRONMENTS.map((e) => ({ value: e, label: humanize(e) }))} />
          </div>
        </div>
        {Object.entries(errors).filter(([k]) => k.startsWith("target.")).map(([k, v]) => (
          <p key={k} role="alert" className="mt-2 text-xs text-destructive">{k}: {v}</p>
        ))}
      </fieldset>

      <fieldset className="rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold text-muted-foreground">Evaluation & notification</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label="Severity" htmlFor="rule-sev">
            <NativeSelect id="rule-sev" value={d.severity} onChange={(e) => set("severity", e.target.value as Severity)}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Evaluate every (s)" htmlFor="rule-eval" error={errors.evaluation_interval_seconds}>
            <Input id="rule-eval" type="number" min={15} value={d.evaluation_interval_seconds} onChange={(e) => set("evaluation_interval_seconds", e.target.value)} />
          </Field>
          <Field label="Consecutive breaches" htmlFor="rule-breach" error={errors.consecutive_breaches}>
            <Input id="rule-breach" type="number" min={1} value={d.consecutive_breaches} onChange={(e) => set("consecutive_breaches", e.target.value)} />
          </Field>
          <Field label="Recovery evaluations" htmlFor="rule-recov" error={errors.recovery_consecutive}>
            <Input id="rule-recov" type="number" min={1} value={d.recovery_consecutive} onChange={(e) => set("recovery_consecutive", e.target.value)} />
          </Field>
          <Field label="Cooldown (s)" htmlFor="rule-cool" error={errors.cooldown_seconds}>
            <Input id="rule-cool" type="number" min={0} value={d.cooldown_seconds} onChange={(e) => set("cooldown_seconds", e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Notification policy" htmlFor="rule-policy" error={errors.notification_policy_id}>
            <PolicySelect id="rule-policy" value={d.notification_policy_id} onChange={(v) => set("notification_policy_id", v)} />
          </Field>
          <div className="flex flex-col justify-end gap-2">
            <CheckboxField id="rule-maint" label="Suppress during maintenance" checked={d.suppress_in_maintenance} onCheckedChange={(v) => set("suppress_in_maintenance", v)} />
            <CheckboxField id="rule-auto" label="Auto-resolve on recovery" checked={d.auto_resolve} onCheckedChange={(v) => set("auto_resolve", v)} />
            <CheckboxField id="rule-enabled" label="Enabled" checked={d.enabled} onCheckedChange={(v) => set("enabled", v)} />
          </div>
        </div>
      </fieldset>

      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" loading={submitting}>{editing ? "Save rule" : "Create rule"}</Button>
      </div>
    </form>
  );
}
