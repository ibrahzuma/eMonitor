import { useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import { orgApi, systemApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { DefinitionList, PageHeader, RelativeTime } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SwitchField, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth, useCan } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { Organization, OrgSettings, SystemStatus, ThresholdPair } from "@/types/api";
import { formatBytes, formatDateTime, formatNumber, listTimeZones } from "@/utils/format";

// ---------------------------------------------------------------- helpers

type IntSettingKey = Exclude<keyof OrgSettings, "ssl_alert_days">;

const INT_SETTINGS: { key: IntSettingKey; label: string; min: number; max: number; hint?: string }[] = [
  { key: "session_idle_minutes", label: "Session idle timeout (minutes)", min: 5, max: 1440 },
  { key: "reopen_window_minutes", label: "Incident reopen window (minutes)", min: 0, max: 10080, hint: "A recurring condition within this window reopens the previous incident" },
  { key: "agent_timeout_seconds", label: "Agent timeout (seconds)", min: 30, max: 86400, hint: "Agent is considered disconnected after this silence" },
  { key: "unreachable_after_failures", label: "Unreachable after failures", min: 1, max: 100 },
  { key: "metric_consecutive_samples", label: "Metric consecutive samples", min: 1, max: 100, hint: "Threshold breaches needed before raising a metric incident" },
  { key: "log_retention_days", label: "Log retention (days)", min: 1, max: 3650 },
  { key: "metric_retention_days", label: "Metric retention (days)", min: 1, max: 3650 },
  { key: "logs_per_day_quota", label: "Log quota (records/day)", min: 0, max: 10_000_000_000, hint: "0 = unlimited" },
];

const THRESHOLD_METRICS: { key: string; label: string; unit: string }[] = [
  { key: "cpu_percent", label: "CPU usage", unit: "%" },
  { key: "memory_percent", label: "Memory usage", unit: "%" },
  { key: "disk_percent", label: "Disk usage", unit: "%" },
  { key: "load_per_core", label: "Load per core", unit: "" },
];

/** Attach backend messages like "session_idle_minutes must be …" or "invalid CIDR …" to fields. */
function errorsFrom(err: unknown, keys: string[], fallbackKey?: string): Record<string, string> {
  const out: Record<string, string> = { ...fieldErrorsOf(err) };
  if (err instanceof ApiError && err.status === 422 && !err.validationDetails.length) {
    const key = keys.find((k) => err.message.startsWith(`${k} `) || err.message.startsWith(`${k}:`));
    if (key) out[key] = err.message;
    else if (fallbackKey) out[fallbackKey] = err.message;
  }
  return out;
}

function useOrg() {
  return useQuery({ queryKey: qk.org, queryFn: orgApi.current });
}

function ReadOnlyNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <p className="mb-3 rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">Read-only: changing organization settings requires the org:settings permission.</p>;
}

// ---------------------------------------------------------------- general

function GeneralTab({ org }: { org: Organization }) {
  const canEdit = useCan("org:settings");
  const { reloadMe } = useAuth();
  const zones = React.useMemo(() => listTimeZones(), []);
  const init = React.useCallback(() => {
    const s = org.settings ?? {};
    const vals: Record<string, string> = {};
    for (const f of INT_SETTINGS) vals[f.key] = s[f.key] === undefined ? "" : String(s[f.key]);
    return { name: org.name, timezone: org.timezone, ssl: (s.ssl_alert_days ?? []).join(", "), vals };
  }, [org]);
  const [form, setForm] = React.useState(init);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  React.useEffect(() => setForm(init()), [init]);

  const save = useApiMutation({
    mutationFn: (body: { name: string; timezone: string; settings: OrgSettings }) => orgApi.update(body),
    invalidate: [qk.org],
    success: "Organization settings saved",
    errorTitle: false,
    onSuccess: () => void reloadMe(),
    onError: (e) => {
      setErrors(errorsFrom(e, [...INT_SETTINGS.map((f) => f.key), "ssl_alert_days"]));
      setFormError(e);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const fe: Record<string, string> = {};
    if (form.name.trim().length < 2) fe.name = "Name must be at least 2 characters";
    const settings: OrgSettings = {};
    for (const f of INT_SETTINGS) {
      const raw = form.vals[f.key]?.trim() ?? "";
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < f.min || n > f.max) fe[f.key] = `Must be a whole number between ${f.min} and ${formatNumber(f.max)}`;
      else settings[f.key] = n;
    }
    const sslItems = form.ssl.split(",").map((x) => x.trim()).filter(Boolean);
    const ssl = sslItems.map(Number);
    if (ssl.some((n) => !Number.isInteger(n) || n < 0 || n > 365)) fe.ssl_alert_days = "Use whole numbers between 0 and 365";
    else if (ssl.length > 10) fe.ssl_alert_days = "At most 10 values";
    else if (ssl.length) settings.ssl_alert_days = ssl;
    setErrors(fe);
    if (Object.keys(fe).length) return;
    save.mutate({ name: form.name.trim(), timezone: form.timezone, settings });
  };

  return (
    <Card>
      <CardHeader><CardTitle>Organization</CardTitle></CardHeader>
      <CardContent>
        <ReadOnlyNote show={!canEdit} />
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {formError !== null && <InlineError error={formError} />}
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Name" htmlFor="org-name" error={errors.name} required>
              <Input id="org-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Time zone" htmlFor="org-tz" error={errors.timezone} hint="Default for reports and new users">
              <NativeSelect id="org-tz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                {!zones.includes(form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </NativeSelect>
            </Field>
            <Field label="SSL alert days" htmlFor="org-ssl" error={errors.ssl_alert_days} hint="Comma separated, e.g. 30, 14, 7, 3, 0">
              <Input id="org-ssl" value={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.value })} />
            </Field>
            {INT_SETTINGS.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`org-${f.key}`} error={errors[f.key]} hint={f.hint ?? `${f.min}–${formatNumber(f.max)}`}>
                <Input id={`org-${f.key}`} type="number" inputMode="numeric" min={f.min} max={f.max} step={1}
                  value={form.vals[f.key] ?? ""} onChange={(e) => setForm({ ...form, vals: { ...form.vals, [f.key]: e.target.value } })} />
              </Field>
            ))}
          </fieldset>
          {canEdit && <div><Button type="submit" loading={save.isPending}>Save settings</Button></div>}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- thresholds

function ThresholdsTab({ org }: { org: Organization }) {
  const canEdit = useCan("org:settings");
  const init = React.useCallback(() => {
    const out: Record<string, { warning: string; critical: string }> = {};
    for (const m of THRESHOLD_METRICS) {
      const t = org.thresholds?.[m.key] ?? {};
      out[m.key] = { warning: t.warning === null || t.warning === undefined ? "" : String(t.warning), critical: t.critical === null || t.critical === undefined ? "" : String(t.critical) };
    }
    return out;
  }, [org]);
  const [vals, setVals] = React.useState(init);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  React.useEffect(() => setVals(init()), [init]);
  const save = useApiMutation({
    mutationFn: (thresholds: Record<string, ThresholdPair>) => orgApi.update({ thresholds }),
    invalidate: [qk.org],
    success: "Default thresholds saved",
    errorTitle: false,
    onError: (e) => {
      setErrors(errorsFrom(e, THRESHOLD_METRICS.map((m) => m.key)));
      setFormError(e);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const fe: Record<string, string> = {};
    const out: Record<string, ThresholdPair> = {};
    for (const m of THRESHOLD_METRICS) {
      const v = vals[m.key];
      const parse = (s: string): number | null | "bad" => {
        if (!s.trim()) return null;
        const n = Number(s);
        return Number.isFinite(n) && n >= 0 ? n : "bad";
      };
      const w = parse(v.warning);
      const c = parse(v.critical);
      if (w === "bad" || c === "bad") fe[m.key] = "Values must be non-negative numbers";
      else if (w !== null && c !== null && w > c) fe[m.key] = "Warning must not exceed critical";
      else out[m.key] = { warning: w, critical: c };
    }
    setErrors(fe);
    if (!Object.keys(fe).length) save.mutate(out);
  };
  return (
    <Card>
      <CardHeader><CardTitle>Default server thresholds</CardTitle></CardHeader>
      <CardContent>
        <ReadOnlyNote show={!canEdit} />
        <p className="mb-3 text-xs text-muted-foreground">Applied to every server unless overridden in the server's settings.</p>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {formError !== null && <InlineError error={formError} />}
          <fieldset disabled={!canEdit} className="flex flex-col gap-3">
            {THRESHOLD_METRICS.map((m) => (
              <div key={m.key} className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[180px_1fr_1fr]">
                <div className="pt-6 text-sm font-medium">{m.label}{m.unit && <span className="ml-1 text-muted-foreground">({m.unit})</span>}</div>
                <Field label="Warning" htmlFor={`th-${m.key}-w`} error={errors[m.key]}>
                  <Input id={`th-${m.key}-w`} type="number" min={0} step="any" value={vals[m.key]?.warning ?? ""}
                    onChange={(e) => setVals({ ...vals, [m.key]: { ...vals[m.key], warning: e.target.value } })} />
                </Field>
                <Field label="Critical" htmlFor={`th-${m.key}-c`}>
                  <Input id={`th-${m.key}-c`} type="number" min={0} step="any" value={vals[m.key]?.critical ?? ""}
                    onChange={(e) => setVals({ ...vals, [m.key]: { ...vals[m.key], critical: e.target.value } })} />
                </Field>
              </div>
            ))}
          </fieldset>
          {canEdit && <div><Button type="submit" loading={save.isPending}>Save thresholds</Button></div>}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- monitoring scope

function lines(s: string): string[] {
  return Array.from(new Set(s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)));
}

function ScopeTab({ org }: { org: Organization }) {
  const canEdit = useCan("org:settings");
  const scope = org.monitoring_scope ?? { allow_public: true, cidrs: [], hostnames: [] };
  const [allowPublic, setAllowPublic] = React.useState(scope.allow_public);
  const [cidrs, setCidrs] = React.useState(scope.cidrs.join("\n"));
  const [hosts, setHosts] = React.useState(scope.hostnames.join("\n"));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  React.useEffect(() => {
    setAllowPublic(scope.allow_public);
    setCidrs(scope.cidrs.join("\n"));
    setHosts(scope.hostnames.join("\n"));
  }, [scope.allow_public, scope.cidrs, scope.hostnames]);
  const save = useApiMutation({
    mutationFn: () => orgApi.update({ monitoring_scope: { allow_public: allowPublic, cidrs: lines(cidrs), hostnames: lines(hosts) } }),
    invalidate: [qk.org],
    success: "Monitoring scope saved",
    errorTitle: false,
    onError: (e) => {
      const fe = errorsFrom(e, []);
      const msg = e instanceof ApiError ? e.validationDetails.map((d) => ({ loc: (d.loc ?? []).join("."), msg: d.msg ?? "" })) : [];
      for (const d of msg) {
        if (d.loc.includes("cidrs")) fe.cidrs = d.msg.replace(/^Value error, /, "");
        if (d.loc.includes("hostnames")) fe.hostnames = d.msg.replace(/^Value error, /, "");
      }
      if (e instanceof ApiError && !msg.length) {
        if (/cidr|address space/i.test(e.message)) fe.cidrs = e.message;
        else if (/hostname/i.test(e.message)) fe.hostnames = e.message;
      }
      setErrors(fe);
      setFormError(e);
    },
  });
  return (
    <Card>
      <CardHeader><CardTitle>Monitoring scope</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ReadOnlyNote show={!canEdit} />
        <div className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-medium">SSRF protection</p>
            <p className="text-xs text-muted-foreground">
              Checks, SMTP relays and webhooks run from eMonitor's network. To prevent server-side request forgery they may only target
              public internet addresses (when allowed below) or the private networks and hostnames you explicitly authorize here.
              Everything else — private ranges, loopback, link-local and cloud metadata addresses — is blocked, and every DNS
              resolution is re-validated at connect time.
            </p>
          </div>
        </div>
        <form noValidate className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); setFormError(null); save.mutate(); }}>
          {formError !== null && <InlineError error={formError} />}
          <fieldset disabled={!canEdit} className="flex flex-col gap-4">
            <SwitchField id="scope-public" label="Allow public internet targets" checked={allowPublic} onCheckedChange={setAllowPublic}
              hint="When off, only the networks and hostnames listed below can be monitored." />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Authorized networks (CIDR)" htmlFor="scope-cidrs" error={errors.cidrs} hint="One per line, e.g. 10.20.0.0/16 or fd00::/8">
                <Textarea id="scope-cidrs" rows={6} className="font-mono text-xs" value={cidrs} onChange={(e) => setCidrs(e.target.value)} />
              </Field>
              <Field label="Authorized hostname patterns" htmlFor="scope-hosts" error={errors.hostnames} hint="One per line. A leading dot matches subdomains: .corp.example.com">
                <Textarea id="scope-hosts" rows={6} className="font-mono text-xs" value={hosts} onChange={(e) => setHosts(e.target.value)} />
              </Field>
            </div>
          </fieldset>
          {canEdit && <div><Button type="submit" loading={save.isPending}>Save scope</Button></div>}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- platform (super admin)

function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { reloadMe } = useAuth();
  const zones = React.useMemo(() => listTimeZones(), []);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [tz, setTz] = React.useState("UTC");
  const [adminEmail, setAdminEmail] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (open) {
      setName(""); setSlug(""); setSlugTouched(false); setTz("UTC"); setAdminEmail(""); setErrors({}); setFormError(null);
    }
  }, [open]);
  const create = useApiMutation({
    mutationFn: () => orgApi.create({ name: name.trim(), slug, timezone: tz, admin_email: adminEmail.trim() || null }),
    invalidate: [qk.orgs],
    success: (o) => `Organization “${o.name}” created`,
    errorTitle: false,
    onSuccess: () => { void reloadMe(); onOpenChange(false); },
    onError: (e) => { setErrors(fieldErrorsOf(e)); setFormError(e); },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const fe: Record<string, string> = {};
    if (name.trim().length < 2) fe.name = "Name must be at least 2 characters";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length < 2) fe.slug = "Lowercase letters, digits and dashes; at least 2 characters";
    if (adminEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail.trim())) fe.admin_email = "Enter a valid email address";
    setErrors(fe);
    if (!Object.keys(fe).length) create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>New tenants start with default settings, thresholds and an open monitoring scope.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="contents">
          <DialogBody className="flex flex-col gap-3">
            {formError !== null && <InlineError error={formError} />}
            <Field label="Name" htmlFor="new-org-name" error={errors.name} required>
              <Input id="new-org-name" value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />
            </Field>
            <Field label="Slug" htmlFor="new-org-slug" error={errors.slug} required hint="Used in URLs; cannot be changed later">
              <Input id="new-org-slug" value={slug} className="font-mono" onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
            </Field>
            <Field label="Time zone" htmlFor="new-org-tz" error={errors.timezone}>
              <NativeSelect id="new-org-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Administrator email (optional)" htmlFor="new-org-admin" error={errors.admin_email} hint="Existing user to make Organization Administrator">
              <Input id="new-org-admin" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function heartbeatAge(v: string | null): { label: string; ok: boolean | null } {
  if (!v) return { label: "no heartbeat", ok: false };
  const n = Number(v);
  const d = Number.isFinite(n) && n > 1e9 ? new Date(n * (n < 1e12 ? 1000 : 1)) : new Date(v);
  if (Number.isNaN(d.getTime())) return { label: v, ok: null };
  const age = (Date.now() - d.getTime()) / 1000;
  return { label: `${formatDateTime(d, { seconds: true })} (${Math.max(0, Math.round(age))}s ago)`, ok: age < 120 };
}

function SystemStatusCard() {
  const q = useQuery({ queryKey: qk.systemStatus, queryFn: systemApi.status, refetchInterval: 30000 });
  const s: SystemStatus | undefined = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Platform status</CardTitle>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}><RefreshCw /> Refresh</Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : s ? (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Components</h3>
              {"error" in (s.heartbeats ?? {}) ? (
                <p className="text-sm text-amber-600 dark:text-amber-400">Heartbeats unavailable: {String(s.heartbeats.error)}</p>
              ) : (
                <DefinitionList items={Object.entries(s.heartbeats ?? {}).map(([k, v]) => {
                  const hb = heartbeatAge(v);
                  return [k, <span key={k} className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${hb.ok === null ? "bg-slate-400" : hb.ok ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden />
                    <span className="text-xs">{hb.label}</span>
                  </span>];
                })} />
              )}
              <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Queues & ingest</h3>
              <DefinitionList items={[
                ...Object.entries(s.queue_depths ?? {}).map(([k, v]) => [`Queue: ${k}`, formatNumber(v)] as [string, string]),
                ["Ingest stream length", s.ingest_stream_length < 0 ? "unavailable" : formatNumber(s.ingest_stream_length)],
                ...(s.ingest_groups ?? []).map((g) => [`Consumer ${g.group}`, `pending ${formatNumber(g.pending)}, lag ${g.lag ?? "n/a"}`] as [string, string]),
                ["Notifications pending", formatNumber(s.notifications.pending)],
                ["Notifications failed (24h)", formatNumber(s.notifications.failed_24h)],
                ["Server time", formatDateTime(s.time, { seconds: true })],
              ]} />
            </section>
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Telemetry storage</h3>
              {!s.clickhouse_storage?.length ? <p className="text-sm text-muted-foreground">No storage statistics available.</p> : (
                <Table>
                  <THead><TR><TH>Table</TH><TH className="text-right">Rows</TH><TH className="text-right">Size</TH><TH>Oldest</TH></TR></THead>
                  <TBody>
                    {s.clickhouse_storage.map((t) => (
                      <TR key={t.table}>
                        <TD className="font-mono text-xs">{t.table}</TD>
                        <TD className="tabular text-right">{formatNumber(t.rows)}</TD>
                        <TD className="tabular text-right">{t.bytes === null ? "—" : formatBytes(t.bytes)}</TD>
                        <TD>{t.oldest ? formatDateTime(t.oldest) : "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PlatformTab() {
  const orgs = useQuery({ queryKey: qk.orgs, queryFn: orgApi.list });
  const [creating, setCreating] = React.useState(false);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Organizations</CardTitle>
          <Button size="sm" onClick={() => setCreating(true)}><Plus /> New organization</Button>
        </CardHeader>
        {orgs.isLoading ? <LoadingState /> : orgs.isError ? <ErrorState error={orgs.error} onRetry={() => void orgs.refetch()} /> : !orgs.data?.length ? (
          <EmptyState title="No organizations" />
        ) : (
          <Table>
            <THead><TR><TH>Name</TH><TH>Slug</TH><TH>Time zone</TH><TH>Status</TH><TH>Created</TH></TR></THead>
            <TBody>
              {orgs.data.map((o) => (
                <TR key={o.id}>
                  <TD className="font-medium">{o.name}</TD>
                  <TD className="font-mono text-xs">{o.slug}</TD>
                  <TD>{o.timezone}</TD>
                  <TD>{o.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Disabled</Badge>}</TD>
                  <TD><RelativeTime value={o.created_at} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <SystemStatusCard />
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

// ---------------------------------------------------------------- page

export function SettingsPage() {
  const { user, can } = useAuth();
  const isPlatform = Boolean(user?.is_superadmin) || can("platform:admin");
  const [params, setParams] = useSearchParams();
  const tabs = ["general", "thresholds", "scope", ...(isPlatform ? ["platform"] : [])];
  const raw = params.get("tab") ?? "general";
  const tab = tabs.includes(raw) ? raw : "general";
  const org = useOrg();
  const orgBody = (render: (o: Organization) => React.ReactNode) =>
    org.isLoading ? <LoadingState /> : org.isError ? <ErrorState error={org.error} onRetry={() => void org.refetch()} /> : org.data ? render(org.data) : null;
  return (
    <div>
      <PageHeader title="System settings" description="Organization configuration, default thresholds and network scope." />
      <Tabs value={tab} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", v); return n; }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="thresholds">Thresholds</TabsTrigger>
          <TabsTrigger value="scope">Monitoring scope</TabsTrigger>
          {isPlatform && <TabsTrigger value="platform">Platform</TabsTrigger>}
        </TabsList>
        <TabsContent value="general">{orgBody((o) => <GeneralTab org={o} />)}</TabsContent>
        <TabsContent value="thresholds">{orgBody((o) => <ThresholdsTab org={o} />)}</TabsContent>
        <TabsContent value="scope">{orgBody((o) => <ScopeTab org={o} />)}</TabsContent>
        {isPlatform && <TabsContent value="platform"><PlatformTab /></TabsContent>}
      </Tabs>
    </div>
  );
}
