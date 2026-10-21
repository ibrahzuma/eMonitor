import { Field, Input, NativeSelect } from "@/components/ui/input";
import type { ThresholdPair } from "@/types/api";

export const THRESHOLD_METRICS = [
  { key: "cpu_percent", label: "CPU %" },
  { key: "memory_percent", label: "Memory %" },
  { key: "disk_percent", label: "Disk %" },
  { key: "load_per_core", label: "Load per core" },
] as const;

export type ThresholdDraft = Record<string, { warning: string; critical: string }>;

export function thresholdsToDraft(t: Record<string, ThresholdPair> | null | undefined): ThresholdDraft {
  const out: ThresholdDraft = {};
  for (const m of THRESHOLD_METRICS) {
    const p = t?.[m.key];
    out[m.key] = {
      warning: p?.warning === null || p?.warning === undefined ? "" : String(p.warning),
      critical: p?.critical === null || p?.critical === undefined ? "" : String(p.critical),
    };
  }
  return out;
}

/** Convert the draft to API thresholds; only metrics with at least one value are included. */
export function draftToThresholds(d: ThresholdDraft, errors: Record<string, string>): Record<string, ThresholdPair> {
  const out: Record<string, ThresholdPair> = {};
  for (const m of THRESHOLD_METRICS) {
    const row = d[m.key];
    if (!row) continue;
    const pair: ThresholdPair = {};
    for (const lvl of ["warning", "critical"] as const) {
      const s = row[lvl].trim();
      if (!s) continue;
      const n = Number(s);
      if (!Number.isFinite(n) || n < 0) errors[`thresholds.${m.key}.${lvl}`] = "Must be a non-negative number";
      else pair[lvl] = n;
    }
    if (typeof pair.warning === "number" && typeof pair.critical === "number" && pair.warning > pair.critical) {
      errors[`thresholds.${m.key}.warning`] = "Warning must not exceed critical";
    }
    if (pair.warning !== undefined || pair.critical !== undefined) out[m.key] = pair;
  }
  return out;
}

export function ThresholdsEditor({ value, onChange, errors, idPrefix }: {
  value: ThresholdDraft;
  onChange: (v: ThresholdDraft) => void;
  errors: Record<string, string>;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {THRESHOLD_METRICS.map((m) => (
        <div key={m.key} className="grid grid-cols-2 gap-2">
          {(["warning", "critical"] as const).map((lvl) => (
            <Field key={lvl} label={`${m.label} ${lvl}`} htmlFor={`${idPrefix}-${m.key}-${lvl}`} error={errors[`thresholds.${m.key}.${lvl}`]}>
              <Input id={`${idPrefix}-${m.key}-${lvl}`} type="number" min={0} step="any" placeholder="org default"
                value={value[m.key]?.[lvl] ?? ""}
                onChange={(e) => onChange({ ...value, [m.key]: { ...(value[m.key] ?? { warning: "", critical: "" }), [lvl]: e.target.value } })} />
            </Field>
          ))}
        </div>
      ))}
    </div>
  );
}

export interface ServerFieldsDraft {
  hostname: string;
  ip_address: string;
  os_family: "linux" | "windows" | "other";
  os_version: string;
  monitoring_interval_seconds: string;
  agent_timeout_seconds: string;
}

export function ServerFields({ value, onChange, errors, idPrefix }: {
  value: ServerFieldsDraft;
  onChange: (v: ServerFieldsDraft) => void;
  errors: Record<string, string>;
  idPrefix: string;
}) {
  const set = <K extends keyof ServerFieldsDraft>(k: K, v: ServerFieldsDraft[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Hostname" htmlFor={`${idPrefix}-hostname`} error={errors.hostname}>
        <Input id={`${idPrefix}-hostname`} value={value.hostname} onChange={(e) => set("hostname", e.target.value)} placeholder="web-01.internal" />
      </Field>
      <Field label="IP address" htmlFor={`${idPrefix}-ip`} error={errors.ip_address}>
        <Input id={`${idPrefix}-ip`} value={value.ip_address} onChange={(e) => set("ip_address", e.target.value)} placeholder="10.0.0.12" />
      </Field>
      <Field label="Operating system" htmlFor={`${idPrefix}-os`} error={errors.os_family}>
        <NativeSelect id={`${idPrefix}-os`} value={value.os_family} onChange={(e) => set("os_family", e.target.value as ServerFieldsDraft["os_family"])}>
          <option value="linux">Linux</option>
          <option value="windows">Windows</option>
          <option value="other">Other</option>
        </NativeSelect>
      </Field>
      <Field label="OS version" htmlFor={`${idPrefix}-osver`} error={errors.os_version}>
        <Input id={`${idPrefix}-osver`} value={value.os_version} onChange={(e) => set("os_version", e.target.value)} placeholder="Ubuntu 24.04" />
      </Field>
      <Field label="Collection interval (s)" htmlFor={`${idPrefix}-interval`} error={errors.monitoring_interval_seconds} hint="10–3600 seconds">
        <Input id={`${idPrefix}-interval`} type="number" min={10} max={3600} value={value.monitoring_interval_seconds}
          onChange={(e) => set("monitoring_interval_seconds", e.target.value)} />
      </Field>
      <Field label="Agent timeout (s)" htmlFor={`${idPrefix}-timeout`} error={errors.agent_timeout_seconds} hint="Empty = organization default">
        <Input id={`${idPrefix}-timeout`} type="number" min={30} max={86400} value={value.agent_timeout_seconds}
          onChange={(e) => set("agent_timeout_seconds", e.target.value)} />
      </Field>
    </div>
  );
}

/** Validate interval/timeout; returns parsed numbers. */
export function parseServerNumbers(v: ServerFieldsDraft, errors: Record<string, string>) {
  const interval = Number(v.monitoring_interval_seconds);
  if (!v.monitoring_interval_seconds.trim() || !Number.isInteger(interval) || interval < 10 || interval > 3600) {
    errors.monitoring_interval_seconds = "Interval must be a whole number between 10 and 3600";
  }
  let timeout: number | null = null;
  if (v.agent_timeout_seconds.trim()) {
    timeout = Number(v.agent_timeout_seconds);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 86400) errors.agent_timeout_seconds = "Timeout must be between 30 and 86400";
  }
  return { interval, timeout };
}
