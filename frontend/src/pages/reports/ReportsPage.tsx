import { useQuery } from "@tanstack/react-query";
import { FileDown, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { errorMessage, type Query } from "@/api/client";
import { reportsApi, resourcesApi, slosApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader, StatusBadge } from "@/components/common";
import { GroupSelect, MultiSelect, PolicySelect, ResourceSelect, TeamSelect } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField, ProgressBar, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { SortTH, sortRows, Table, TBody, TD, TH, THead, TR, useSort } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useCan } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import { ENVIRONMENTS, type JsonValue, type Report, REPORT_NAMES, type ReportName, RESOURCE_KINDS, type Slo, type SloIn } from "@/types/api";
import { formatDateTime, formatNumber, humanize, localInputToIso } from "@/utils/format";
import { KIND_LABELS, resourcePath, SERIES_COLORS, severityStyle } from "@/utils/status";

const REPORTS: Record<ReportName, { label: string; description: string }> = {
  availability: { label: "Availability", description: "Uptime, coverage and downtime for every monitored resource." },
  "website-uptime": { label: "Website uptime", description: "Availability and response times of websites and APIs." },
  "service-availability": { label: "Service availability", description: "Services, databases, applications and network devices." },
  incidents: { label: "Incidents", description: "Incident volume by day and severity with MTTD / MTTA / MTTR." },
  alerts: { label: "Alert volume", description: "Alerting activity by rule and source." },
  utilization: { label: "Server utilization", description: "CPU, memory and disk utilization per server." },
  capacity: { label: "Capacity", description: "Disk and memory headroom with growth trends." },
  ssl: { label: "SSL certificates", description: "Certificate expiry across all TLS/HTTPS checks." },
  "log-errors": { label: "Log errors", description: "Error log volume by application and host." },
  sla: { label: "SLA / SLO", description: "Service level objectives and error budgets." },
};

type Range = "24h" | "7d" | "30d" | "90d" | "custom";

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "reports";
  return (
    <div>
      <PageHeader title="Reports & SLOs" description="Operational reports from stored monitoring data and service level objectives." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="reports">Reports</TabsTrigger>
          <TabsTrigger value="slos">SLOs</TabsTrigger>
        </TabsList>
        <TabsContent value="reports"><ReportsTab /></TabsContent>
        <TabsContent value="slos"><SlosTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- reports

function isNum(v: JsonValue | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function cell(v: JsonValue | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return formatNumber(v, 2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T/.test(v) ? formatDateTime(v) : v;
  return JSON.stringify(v);
}

function SummaryValue({ v }: { v: JsonValue }) {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return <span className="text-muted-foreground">—</span>;
    return (
      <ul className="mt-0.5 flex flex-col gap-0.5 text-xs">
        {entries.map(([k, x]) => <li key={k} className="flex justify-between gap-3"><span className="text-muted-foreground">{humanize(k)}</span><span className="tabular">{cell(x)}</span></li>)}
      </ul>
    );
  }
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-muted-foreground">—</span>;
    return (
      <ul className="mt-0.5 flex flex-col gap-0.5 text-xs">
        {v.slice(0, 6).map((x, i) => (
          <li key={i} className="truncate">
            {x !== null && typeof x === "object" && !Array.isArray(x) ? Object.values(x).map((y) => cell(y)).join(" · ") : cell(x)}
          </li>
        ))}
      </ul>
    );
  }
  return <span className="tabular text-lg font-semibold">{cell(v)}</span>;
}

function SummaryCards({ name, summary }: { name: ReportName; summary: Report["summary"] }) {
  const entries = Object.entries(summary).filter(([k]) => !(name === "incidents" && /^(mttd|mtta|mttr)(_seconds)?$/.test(k)));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {name === "incidents" && (["mttd", "mtta", "mttr"] as const).map((k) => (
        <div key={k} className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">{k.toUpperCase()}</p>
          <p className="tabular text-xl font-semibold">{typeof summary[k] === "string" && summary[k] ? String(summary[k]) : "—"}</p>
        </div>
      ))}
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-lg border bg-card px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">{humanize(k)}</p>
          <SummaryValue v={v} />
        </div>
      ))}
    </div>
  );
}

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, color: "var(--popover-foreground)",
};

/** Pick a sensible chart for a generic report. */
function chartSpec(rep: Report): { kind: "stacked"; x: string; ys: string[] } | { kind: "bar"; x: string; y: string } | null {
  if (!rep.rows.length) return null;
  const keys = rep.columns.map((c) => c.key);
  const numeric = keys.filter((k) => rep.rows.some((r) => isNum(r[k])) && rep.rows.every((r) => r[k] === null || r[k] === undefined || isNum(r[k])));
  if (keys.includes("date")) {
    const ys = numeric.filter((k) => k !== "total");
    return ys.length ? { kind: "stacked", x: "date", ys } : null;
  }
  const pct = numeric.find((k) => /percent|_pct$/.test(k));
  const text = keys.find((k) => rep.rows.every((r) => typeof r[k] === "string"));
  if (pct && text) return { kind: "bar", x: text, y: pct };
  return null;
}

function ReportChart({ rep }: { rep: Report }) {
  const spec = chartSpec(rep);
  if (!spec) return null;
  const label = (k: string) => rep.columns.find((c) => c.key === k)?.label ?? k;
  if (spec.kind === "stacked") {
    return (
      <div role="img" aria-label={`${rep.title} chart`} className="h-60">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rep.rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey={spec.x} tickLine={false} axisLine={false} minTickGap={20} />
            <YAxis width={40} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            {spec.ys.map((k, i) => (
              <Bar key={k} dataKey={k} name={label(k)} stackId="a" isAnimationActive={false}
                fill={["critical", "high", "warning", "info"].includes(k) ? severityStyle(k).fill : SERIES_COLORS[i % SERIES_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  const rows = sortRows(rep.rows, { key: spec.y, dir: "asc" }, (r, k) => (isNum(r[k]) ? (r[k] as number) : null)).slice(0, 25);
  return (
    <div role="img" aria-label={`${label(spec.y)} by ${label(spec.x)}`} style={{ height: Math.max(120, rows.length * 22 + 30) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" domain={/percent/.test(spec.y) ? [0, 100] : [0, "auto"]} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey={spec.x} width={150} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [formatNumber(v, 3), label(spec.y)]} />
          <Bar dataKey={spec.y} name={label(spec.y)} fill={SERIES_COLORS[0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ReportTable({ rep }: { rep: Report }) {
  const { sort, onSort } = useSort<string>(null);
  const rows = sortRows(rep.rows, sort, (r, k) => {
    const v = r[k];
    return typeof v === "number" || typeof v === "string" ? v : v === null || v === undefined ? null : JSON.stringify(v);
  });
  if (!rep.rows.length) return <EmptyState title="No rows for this report and range" />;
  return (
    <Table>
      <THead>
        <TR>{rep.columns.map((c) => <SortTH key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={onSort} />)}</TR>
      </THead>
      <TBody>
        {rows.map((r, i) => (
          <TR key={i}>
            {rep.columns.map((c) => (
              <TD key={c.key} className={isNum(r[c.key]) ? "tabular" : undefined}>
                {c.key === "severity" && typeof r[c.key] === "string" ? <span style={{ color: severityStyle(String(r[c.key])).fill }}>{String(r[c.key])}</span>
                  : c.key === "status" && typeof r[c.key] === "string" ? <StatusBadge status={String(r[c.key])} /> : cell(r[c.key])}
              </TD>
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function ReportsTab() {
  const toast = useToast();
  const [name, setName] = React.useState<ReportName>("availability");
  const [range, setRange] = React.useState<Range>("7d");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [environment, setEnvironment] = React.useState("");
  const [kinds, setKinds] = React.useState<string[]>([]);
  const [team, setTeam] = React.useState("");
  const [group, setGroup] = React.useState("");
  const [downloading, setDownloading] = React.useState<"csv" | "pdf" | null>(null);

  const customInvalid = range === "custom" && (!start || !end || (localInputToIso(start) ?? "") >= (localInputToIso(end) ?? ""));
  const query: Query = {
    ...(range === "custom" ? { start: localInputToIso(start), end: localInputToIso(end), range: null } : { range }),
    environment, kind: kinds, team_id: team, group_id: group,
  };
  const q = useQuery({ queryKey: qk.report(name, query), queryFn: () => reportsApi.get(name, query), enabled: !customInvalid });

  const download = async (fmt: "csv" | "pdf") => {
    setDownloading(fmt);
    try {
      const file = await reportsApi.download(name, query, fmt);
      toast.success("Report downloaded", file);
    } catch (e) {
      toast.error("Download failed", errorMessage(e));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[260px_1fr]">
            <Field label="Report" htmlFor="rep-name" hint={REPORTS[name].description}>
              <NativeSelect id="rep-name" value={name} onChange={(e) => setName(e.target.value as ReportName)}>
                {REPORT_NAMES.map((n) => <option key={n} value={n}>{REPORTS[n].label}</option>)}
              </NativeSelect>
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">Time range</span>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented label="Report range" value={range} onChange={setRange}
                  options={[{ value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "90d", label: "90d" }, { value: "custom", label: "Custom" }] as const} />
                {range === "custom" && (
                  <>
                    <Input aria-label="Start" type="datetime-local" className="w-auto" value={start} onChange={(e) => setStart(e.target.value)} />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input aria-label="End" type="datetime-local" className="w-auto" value={end} onChange={(e) => setEnd(e.target.value)} />
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Environment" htmlFor="rep-env">
              <NativeSelect id="rep-env" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                <option value="">All environments</option>
                {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
              </NativeSelect>
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">Kinds</span>
              <MultiSelect ariaLabel="Resource kinds" placeholder="All kinds" value={kinds} onChange={setKinds}
                options={RESOURCE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] ?? k }))} />
            </div>
            <Field label="Team" htmlFor="rep-team"><TeamSelect id="rep-team" value={team} onChange={setTeam} /></Field>
            <Field label="Group" htmlFor="rep-group"><GroupSelect id="rep-group" value={group} onChange={setGroup} emptyLabel="All groups" /></Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={customInvalid} loading={downloading === "csv"} onClick={() => void download("csv")}><FileDown /> CSV</Button>
            <Button variant="outline" size="sm" disabled={customInvalid} loading={downloading === "pdf"} onClick={() => void download("pdf")}><FileText /> PDF</Button>
            {customInvalid && <span className="self-center text-xs text-muted-foreground">Choose a valid start and end.</span>}
          </div>
        </CardContent>
      </Card>
      {customInvalid ? null : q.isLoading ? <LoadingState label="Generating report…" /> : q.isError ? (
        <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
      ) : q.data ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">{q.data.title}</h2>
            {q.data.start && <span className="text-xs text-muted-foreground">{formatDateTime(q.data.start)} – {formatDateTime(q.data.end)}</span>}
          </div>
          {Object.keys(q.data.summary).length > 0 && <SummaryCards name={name} summary={q.data.summary} />}
          {chartSpec(q.data) && <Card><CardContent><ReportChart rep={q.data} /></CardContent></Card>}
          <Card><ReportTable rep={q.data} /></Card>
          {q.data.notes.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">{q.data.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          )}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- SLOs

interface SloForm {
  name: string; description: string; resource_id: string; check_id: string; target_percent: string; window_days: string;
  burn_rate_alerts: boolean; fast_burn_threshold: string; slow_burn_threshold: string; notification_policy_id: string;
}

function sloToForm(s: Slo | null): SloForm {
  return {
    name: s?.name ?? "", description: s?.description ?? "", resource_id: s?.resource_id ?? "", check_id: s?.check_id ?? "",
    target_percent: String(s?.target_percent ?? 99.9), window_days: String(s?.window_days ?? 30),
    burn_rate_alerts: s?.burn_rate_alerts ?? true, fast_burn_threshold: String(s?.fast_burn_threshold ?? 14.4),
    slow_burn_threshold: String(s?.slow_burn_threshold ?? 6), notification_policy_id: s?.notification_policy_id ?? "",
  };
}

function sloPayload(f: SloForm): { payload: SloIn | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = "Name is required";
  if (!f.resource_id) errors.resource_id = "Select a resource";
  const t = Number(f.target_percent);
  if (!(t > 0 && t < 100)) errors.target_percent = "Target must be between 0 and 100 (exclusive)";
  const w = Number(f.window_days);
  if (!Number.isInteger(w) || w < 1 || w > 365) errors.window_days = "1–365 days";
  const fast = Number(f.fast_burn_threshold);
  const slow = Number(f.slow_burn_threshold);
  if (!(fast > 0 && fast <= 1000)) errors.fast_burn_threshold = "0–1000";
  if (!(slow > 0 && slow <= 1000)) errors.slow_burn_threshold = "0–1000";
  if (Object.keys(errors).length) return { payload: null, errors };
  return {
    payload: {
      name: f.name.trim(), description: f.description, resource_id: f.resource_id, check_id: f.check_id || null, target_percent: t,
      window_days: w, burn_rate_alerts: f.burn_rate_alerts, fast_burn_threshold: fast, slow_burn_threshold: slow,
      notification_policy_id: f.notification_policy_id || null,
    },
    errors,
  };
}

function SloDialog({ open, onOpenChange, slo }: { open: boolean; onOpenChange: (o: boolean) => void; slo: Slo | null }) {
  const [f, setF] = React.useState<SloForm>(() => sloToForm(slo));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) { setF(sloToForm(slo)); setErrors({}); }
  }, [open, slo]);
  const set = <K extends keyof SloForm>(k: K, v: SloForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const checks = useQuery({ queryKey: ["resources", "checks", f.resource_id], queryFn: () => resourcesApi.checks(f.resource_id), enabled: Boolean(f.resource_id) });
  const save = useApiMutation({
    mutationFn: async () => {
      const { payload, errors: errs } = sloPayload(f);
      setErrors(errs);
      if (!payload) throw new Error("Please fix the highlighted fields");
      return slo ? slosApi.update(slo.id, payload) : slosApi.create(payload);
    },
    invalidate: [qk.slos],
    success: slo ? "SLO updated" : "SLO created",
    errorTitle: "Could not save SLO",
    onSuccess: () => onOpenChange(false),
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{slo ? `Edit SLO “${slo.name}”` : "New SLO"}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="slo-name" error={errors.name} required className="sm:col-span-2">
              <Input id="slo-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Description" htmlFor="slo-desc" className="sm:col-span-2">
              <Textarea id="slo-desc" rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Field label="Resource" htmlFor="slo-res" error={errors.resource_id} required>
              <ResourceSelect id="slo-res" value={f.resource_id} onChange={(v) => setF((p) => ({ ...p, resource_id: v, check_id: "" }))} emptyLabel="Select a resource…" />
            </Field>
            <Field label="Check" htmlFor="slo-check" error={errors.check_id} hint="Empty = all checks of the resource">
              <NativeSelect id="slo-check" value={f.check_id} onChange={(e) => set("check_id", e.target.value)} disabled={!f.resource_id || checks.isLoading}>
                <option value="">All checks</option>
                {(checks.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.type})</option>)}
              </NativeSelect>
            </Field>
            <Field label="Target (%)" htmlFor="slo-target" error={errors.target_percent}>
              <Input id="slo-target" type="number" step="0.001" value={f.target_percent} onChange={(e) => set("target_percent", e.target.value)} />
            </Field>
            <Field label="Window (days)" htmlFor="slo-window" error={errors.window_days}>
              <Input id="slo-window" type="number" min={1} max={365} value={f.window_days} onChange={(e) => set("window_days", e.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <CheckboxField id="slo-burn" label="Alert on error-budget burn rate" checked={f.burn_rate_alerts} onCheckedChange={(v) => set("burn_rate_alerts", v)} />
            </div>
            {f.burn_rate_alerts && (
              <>
                <Field label="Fast burn threshold (1h)" htmlFor="slo-fast" error={errors.fast_burn_threshold}>
                  <Input id="slo-fast" type="number" step="0.1" value={f.fast_burn_threshold} onChange={(e) => set("fast_burn_threshold", e.target.value)} />
                </Field>
                <Field label="Slow burn threshold (6h)" htmlFor="slo-slow" error={errors.slow_burn_threshold}>
                  <Input id="slo-slow" type="number" step="0.1" value={f.slow_burn_threshold} onChange={(e) => set("slow_burn_threshold", e.target.value)} />
                </Field>
              </>
            )}
            <Field label="Notification policy" htmlFor="slo-policy" className="sm:col-span-2">
              <PolicySelect id="slo-policy" value={f.notification_policy_id} onChange={(v) => set("notification_policy_id", v)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{slo ? "Save SLO" : "Create SLO"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function budgetColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return "#94a3b8";
  return v < 0 ? "#ef4444" : v < 25 ? "#f97316" : v < 50 ? "#f59e0b" : "#10b981";
}

function burn(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Number.isFinite(v) ? `${v.toFixed(2)}×` : "∞";
}

function SlosTab() {
  const canManage = useCan("slo:manage");
  const q = useQuery({ queryKey: qk.slos, queryFn: () => slosApi.list(true) });
  const [editing, setEditing] = React.useState<Slo | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Slo | null>(null);
  const resources = useQuery({ queryKey: qk.resourceList("slo-kinds", {}), queryFn: () => resourcesApi.list({ page_size: 500 }) });
  const kindOf = new Map((resources.data?.items ?? []).map((r) => [r.id, r.kind] as const));
  const remove = useApiMutation({ mutationFn: (id: string) => slosApi.remove(id), success: "SLO deleted", invalidate: [qk.slos], onSuccess: () => setDeleting(null) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Service level objectives</CardTitle>
        {canManage && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> New SLO</Button>}
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No SLOs defined" description="Define an availability target for a resource to track its error budget and burn rate." />
      ) : (
        <Table>
          <THead><TR><TH>Name</TH><TH>Resource</TH><TH>Target</TH><TH>Window</TH><TH>SLI</TH><TH className="min-w-[160px]">Error budget left</TH><TH>Burn 1h / 6h</TH><TH>Status</TH><TH /></TR></THead>
          <TBody>
            {q.data.map((s) => {
              const st = s.last_status ?? {};
              const rem = st.error_budget_remaining_percent;
              return (
                <TR key={s.id}>
                  <TD className="font-medium">{s.name}{s.description && <p className="text-xs font-normal text-muted-foreground">{s.description}</p>}</TD>
                  <TD><Link className="hover:underline" to={resourcePath(kindOf.get(s.resource_id), s.resource_id)}>{s.resource_name ?? s.resource_id.slice(0, 8)}</Link></TD>
                  <TD className="tabular">{s.target_percent}%</TD>
                  <TD className="tabular">{s.window_days}d</TD>
                  <TD className="tabular">{st.sli_percent === null || st.sli_percent === undefined ? "—" : `${st.sli_percent.toFixed(3)}%`}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <ProgressBar value={rem === null || rem === undefined ? 0 : Math.max(0, rem)} color={budgetColor(rem)} label={`Error budget remaining for ${s.name}`} />
                      <span className="tabular w-14 text-right text-xs">{rem === null || rem === undefined ? "—" : `${rem.toFixed(1)}%`}</span>
                    </div>
                  </TD>
                  <TD className="tabular text-xs">{burn(st.burn_rate_1h)} / {burn(st.burn_rate_6h)}</TD>
                  <TD><StatusBadge status={st.status ?? "no_data"} /></TD>
                  <TD className="text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${s.name}`} onClick={() => { setEditing(s); setOpen(true); }}><Pencil /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}><Trash2 className="text-destructive" /></Button>
                      </div>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <SloDialog open={open} onOpenChange={setOpen} slo={editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete SLO “${deleting?.name ?? ""}”?`}
        destructive confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}
