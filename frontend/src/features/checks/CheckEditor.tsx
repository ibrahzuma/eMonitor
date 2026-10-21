import { Plus, X } from "lucide-react";
import * as React from "react";
import { KeyValueEditor } from "@/components/common";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/controls";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import {
  type AssertionDraft,
  CHECK_TYPE_LABELS,
  CONFIG_SPECS,
  type CheckDraft,
  type DraftValues,
  type FieldSpec,
  SECRET_SPECS,
  defaultCheckDraft,
} from "@/features/checks/checkSpecs";
import { CHECK_TYPES, type CheckType, SEVERITIES, type Severity } from "@/types/api";

const OPS: AssertionDraft["op"][] = ["eq", "ne", "exists", "contains", "gt", "lt"];

function AssertionsEditor({ idPrefix, value, onChange }: { idPrefix: string; value: AssertionDraft[]; onChange: (v: AssertionDraft[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((a, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
          <Input id={`${idPrefix}-path-${i}`} aria-label={`Assertion ${i + 1} path`} placeholder="data.status" value={a.path}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
          <NativeSelect aria-label={`Assertion ${i + 1} operator`} value={a.op} className="w-24"
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, op: e.target.value as AssertionDraft["op"] } : x)))}>
            {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
          </NativeSelect>
          <Input aria-label={`Assertion ${i + 1} value`} placeholder='"ok" or 200' value={a.value} disabled={a.op === "exists"}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <Button variant="ghost" size="icon-sm" aria-label={`Remove assertion ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => onChange([...value, { path: "", op: "eq", value: "" }])}>
          <Plus /> Add assertion
        </Button>
      </div>
    </div>
  );
}

export function SpecFields({ specs, values, onChange, errors, idPrefix, errorPrefix, secret, context }: {
  specs: FieldSpec[];
  values: DraftValues;
  onChange: (v: DraftValues) => void;
  errors: Record<string, string>;
  idPrefix: string;
  errorPrefix: string;
  secret?: boolean;
  /** Values used for `when` predicates (defaults to `values`). */
  context?: DraftValues;
}) {
  const ctx = context ?? values;
  const set = (key: string, v: DraftValues[string]) => onChange({ ...values, [key]: v });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {specs.filter((s) => !s.when || s.when(ctx)).map((s) => {
        const id = `${idPrefix}-${s.key}`;
        const err = errors[`${errorPrefix}${s.key}`];
        const v = values[s.key];
        if (s.kind === "bool") {
          return (
            <div key={s.key} className="flex items-end pb-1">
              <CheckboxField id={id} label={s.label} checked={v === true} onCheckedChange={(c) => set(s.key, c)} hint={s.hint} />
            </div>
          );
        }
        if (s.kind === "kv") {
          return (
            <div key={s.key} className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium">{s.label}</span>
              {s.hint && <span className="text-xs text-muted-foreground">{s.hint}</span>}
              <KeyValueEditor idPrefix={id} value={(v as [string, string][]) ?? []} onChange={(x) => set(s.key, x)} secret={secret} />
              {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
            </div>
          );
        }
        if (s.kind === "assertions") {
          return (
            <div key={s.key} className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-xs font-medium">{s.label}</span>
              <AssertionsEditor idPrefix={id} value={(v as AssertionDraft[]) ?? []} onChange={(x) => set(s.key, x)} />
              {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
            </div>
          );
        }
        const wide = s.kind === "textarea" || s.key === "url";
        return (
          <Field key={s.key} label={s.label} htmlFor={id} error={err} hint={s.hint} required={s.required} className={wide ? "sm:col-span-2" : undefined}>
            {s.kind === "select" ? (
              <NativeSelect id={id} value={String(v ?? "")} onChange={(e) => set(s.key, e.target.value)}>
                {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </NativeSelect>
            ) : s.kind === "textarea" ? (
              <Textarea id={id} value={String(v ?? "")} onChange={(e) => set(s.key, e.target.value)} className="font-mono text-xs" />
            ) : (
              <Input id={id} value={String(v ?? "")} placeholder={secret ? "Leave blank to keep current value" : s.placeholder}
                type={s.kind === "password" ? "password" : s.kind === "number" ? "number" : "text"}
                autoComplete={secret ? "new-password" : "off"} min={s.min} max={s.max}
                onChange={(e) => set(s.key, e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

/**
 * Full check editor: type, name, schedule, thresholds and type-specific config + write-only secrets.
 * Error keys follow draftToCheckIn(): "name", "config.<key>", "secrets.<key>", "interval_seconds"…
 */
export function CheckEditor({ value, onChange, errors, idPrefix, lockType, hasSecrets, allowedTypes }: {
  value: CheckDraft;
  onChange: (d: CheckDraft) => void;
  errors: Record<string, string>;
  idPrefix: string;
  lockType?: boolean;
  hasSecrets?: boolean;
  allowedTypes?: readonly CheckType[];
}) {
  const secretSpecs = SECRET_SPECS[value.type] ?? [];
  const setField = <K extends keyof CheckDraft>(k: K, v: CheckDraft[K]) => onChange({ ...value, [k]: v });
  const types = allowedTypes ?? CHECK_TYPES;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Check type" htmlFor={`${idPrefix}-type`}>
          <NativeSelect id={`${idPrefix}-type`} value={value.type} disabled={lockType}
            onChange={(e) => {
              const t = e.target.value as CheckType;
              const fresh = defaultCheckDraft(t);
              onChange({ ...fresh, name: value.name === CHECK_TYPE_LABELS[value.type] ? fresh.name : value.name,
                interval_seconds: value.interval_seconds, timeout_seconds: value.timeout_seconds, severity: value.severity });
            }}>
            {types.map((t) => <option key={t} value={t}>{CHECK_TYPE_LABELS[t]}</option>)}
          </NativeSelect>
        </Field>
        <Field label="Check name" htmlFor={`${idPrefix}-name`} error={errors.name} required className="sm:col-span-2">
          <Input id={`${idPrefix}-name`} value={value.name} onChange={(e) => setField("name", e.target.value)} />
        </Field>
      </div>

      <fieldset className="rounded-md border p-3">
        <legend className="px-1 text-xs font-semibold text-muted-foreground">{CHECK_TYPE_LABELS[value.type]} settings</legend>
        <SpecFields specs={CONFIG_SPECS[value.type]} values={value.config} onChange={(c) => setField("config", c)}
          errors={errors} idPrefix={`${idPrefix}-cfg`} errorPrefix="config." />
      </fieldset>

      {secretSpecs.length > 0 && (
        <fieldset className="rounded-md border p-3">
          <legend className="px-1 text-xs font-semibold text-muted-foreground">Credentials (write-only)</legend>
          <p className="mb-2 text-xs text-muted-foreground">
            Secrets are encrypted and never shown again.{hasSecrets ? " Credentials are configured; leave fields blank to keep them." : ""}
          </p>
          <SpecFields specs={secretSpecs} values={value.secrets} onChange={(s) => setField("secrets", s)} errors={errors}
            idPrefix={`${idPrefix}-sec`} errorPrefix="secrets." secret context={{ ...value.secrets, version: value.config.version ?? "" }} />
        </fieldset>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Interval (s)" htmlFor={`${idPrefix}-interval`} error={errors.interval_seconds}>
          <Input id={`${idPrefix}-interval`} type="number" min={10} max={86400} value={value.interval_seconds}
            onChange={(e) => setField("interval_seconds", e.target.value)} />
        </Field>
        <Field label="Timeout (s)" htmlFor={`${idPrefix}-timeout`} error={errors.timeout_seconds}>
          <Input id={`${idPrefix}-timeout`} type="number" min={1} max={120} value={value.timeout_seconds}
            onChange={(e) => setField("timeout_seconds", e.target.value)} />
        </Field>
        <Field label="Failures to alert" htmlFor={`${idPrefix}-fail`} error={errors.failure_threshold}>
          <Input id={`${idPrefix}-fail`} type="number" min={1} max={100} value={value.failure_threshold}
            onChange={(e) => setField("failure_threshold", e.target.value)} />
        </Field>
        <Field label="Successes to recover" htmlFor={`${idPrefix}-rec`} error={errors.recovery_threshold}>
          <Input id={`${idPrefix}-rec`} type="number" min={1} max={100} value={value.recovery_threshold}
            onChange={(e) => setField("recovery_threshold", e.target.value)} />
        </Field>
        <Field label="Severity" htmlFor={`${idPrefix}-sev`}>
          <NativeSelect id={`${idPrefix}-sev`} value={value.severity} onChange={(e) => setField("severity", e.target.value as Severity)}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <CheckboxField id={`${idPrefix}-enabled`} label="Enabled" checked={value.enabled} onCheckedChange={(v) => setField("enabled", v)} />
    </div>
  );
}

export function useCheckDraft(initial: () => CheckDraft) {
  return React.useState<CheckDraft>(initial);
}
