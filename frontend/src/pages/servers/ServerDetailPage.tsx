import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, ShieldOff } from "lucide-react";
import * as React from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { agentsApi, metricsApi, serversApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { CodeBlock, DefinitionList, RelativeTime, StatusBadge, TagInput } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProgressBar, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { EmptyState, InlineError } from "@/components/ui/states";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import {
  ChecksPanel,
  DetailState,
  ResourceEventsPanel,
  ResourceHeader,
  ResourceIncidentsPanel,
  ResourceLogsPanel,
  ResourceMetaCard,
  ResourceSettingsPanel,
  useResource,
} from "@/features/resources/panels";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { EnrollmentTokenCreated, Resource } from "@/types/api";
import { formatBytes, formatDateTime, formatDuration, formatNumber, formatPercent, humanize } from "@/utils/format";
import { MetricChart } from "@/pages/servers/MetricChart";
import {
  ServerFields,
  type ServerFieldsDraft,
  ThresholdsEditor,
  draftToThresholds,
  parseServerNumbers,
  thresholdsToDraft,
} from "@/pages/servers/serverForm";

const TABS = ["overview", "metrics", "checks", "incidents", "logs", "events", "agent", "settings"] as const;
type Tab = (typeof TABS)[number];
const RANGES = ["15m", "1h", "6h", "24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

const pct = (v: number) => `${v.toFixed(0)}%`;
const bytesPs = (v: number) => `${formatBytes(v)}/s`;

function meterColor(v: number | undefined, warn = 80, crit = 90) {
  if (v === undefined) return undefined;
  return v >= crit ? "#ef4444" : v >= warn ? "#f59e0b" : "#10b981";
}

function MetricCard({ label, value, sub, bar, barColor }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  bar?: number;
  barColor?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular text-xl font-semibold leading-tight">{value}</span>
      {bar !== undefined && <ProgressBar value={bar} color={barColor} label={label} />}
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function OverviewTab({ resource }: { resource: Resource }) {
  const sd = resource.server;
  const l = sd?.latest ?? {};
  const th = sd?.thresholds ?? {};
  const interval = useLiveInterval(60000, 30000);
  const latest = useQuery({ queryKey: qk.metricLatest(resource.id), queryFn: () => metricsApi.latest(resource.id), refetchInterval: interval });
  const net = (latest.data ?? []).filter((m) => m.metric === "net_rx_bytes_ps" || m.metric === "net_tx_bytes_ps");
  const rx = net.filter((m) => m.metric === "net_rx_bytes_ps").reduce((a, m) => a + m.value, 0);
  const tx = net.filter((m) => m.metric === "net_tx_bytes_ps").reduce((a, m) => a + m.value, 0);
  const disks = Object.entries(l.disks ?? {});
  const noData = !sd?.last_metrics_at;
  return (
    <div className="flex flex-col gap-4">
      {noData && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden />
          <span>No metrics received yet. Open the <strong>Agent</strong> tab to create an enrollment token and install the agent.</span>
        </div>
      )}
      <section aria-label="Live metrics" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="CPU" value={formatPercent(l.cpu_percent)} bar={l.cpu_percent}
          barColor={meterColor(l.cpu_percent, th.cpu_percent?.warning ?? 80, th.cpu_percent?.critical ?? 95)}
          sub={sd?.cpu_count ? `${sd.cpu_count} cores` : undefined} />
        <MetricCard label="Memory" value={formatPercent(l.memory_percent)} bar={l.memory_percent}
          barColor={meterColor(l.memory_percent, th.memory_percent?.warning ?? 85, th.memory_percent?.critical ?? 95)}
          sub={sd?.memory_total_bytes ? `${formatBytes(l.memory_used_bytes)} / ${formatBytes(sd.memory_total_bytes)}` : undefined} />
        <MetricCard label="Disk (fullest)" value={formatPercent(l.disk_percent_max)} bar={l.disk_percent_max}
          barColor={meterColor(l.disk_percent_max, th.disk_percent?.warning ?? 80, th.disk_percent?.critical ?? 90)} />
        <MetricCard label="Load (1/5/15)" value={l.load1 !== undefined ? formatNumber(l.load1, 2) : "—"}
          sub={l.load5 !== undefined ? `${formatNumber(l.load5, 2)} / ${formatNumber(l.load15, 2)}` : undefined} />
        <MetricCard label="Swap" value={formatPercent(l.swap_percent)} bar={l.swap_percent} barColor={meterColor(l.swap_percent)} />
        <MetricCard label="Uptime" value={formatDuration(l.uptime_seconds ?? sd?.uptime_seconds)} />
        <MetricCard label="Processes" value={formatNumber(l.process_count)} />
        <MetricCard label="TCP connections" value={formatNumber(l.tcp_connections)} />
        <MetricCard label="Network in" value={net.length ? bytesPs(rx) : "—"} />
        <MetricCard label="Network out" value={net.length ? bytesPs(tx) : "—"} />
        <MetricCard label="Last sample" value={<span className="text-sm"><RelativeTime value={sd?.last_metrics_at ?? null} /></span>} />
      </section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ResourceMetaCard resource={resource} extra={[
          ["Hostname", sd?.hostname ?? ""],
          ["IP address", sd?.ip_address ? <span className="font-mono text-xs">{sd.ip_address}</span> : ""],
          ["OS", [humanize(sd?.os_family ?? ""), sd?.os_version].filter(Boolean).join(" ")],
          ["Kernel", sd?.kernel ?? ""],
          ["CPU cores", sd?.cpu_count ? String(sd.cpu_count) : ""],
          ["Memory", sd?.memory_total_bytes ? formatBytes(sd.memory_total_bytes) : ""],
          ["Collection interval", sd ? `${sd.monitoring_interval_seconds}s` : ""],
          ["Last metrics", sd?.last_metrics_at ? formatDateTime(sd.last_metrics_at, { seconds: true }) : "never"],
          ["Monitored services", sd?.monitored_services.join(", ") ?? ""],
        ]} />
        <Card>
          <CardHeader><CardTitle>Disks</CardTitle></CardHeader>
          {!disks.length ? <EmptyState title="No disk metrics yet" /> : (
            <CardContent className="flex flex-col gap-2.5">
              {disks.map(([mount, v]) => (
                <div key={mount} className="flex flex-col gap-1">
                  <div className="flex justify-between text-xs"><span className="font-mono">{mount}</span><span className="tabular">{formatPercent(v)}</span></div>
                  <ProgressBar value={v} color={meterColor(v, th.disk_percent?.warning ?? 80, th.disk_percent?.critical ?? 90)} label={`Disk ${mount}`} />
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

const KNOWN = new Set(["cpu_percent", "memory_percent", "load1", "load5", "load15", "disk_percent", "net_rx_bytes_ps", "net_tx_bytes_ps"]);

function MetricsTab({ resource }: { resource: Resource }) {
  const [range, setRange] = React.useState<Range>("1h");
  const [extra, setExtra] = React.useState("");
  const interval = useLiveInterval(60000, 30000);
  const names = useQuery({ queryKey: qk.metricNames(resource.id), queryFn: () => metricsApi.names(resource.id) });
  const metricSet = Array.from(new Set((names.data ?? []).map((n) => n.metric))).sort();
  const has = (m: string) => metricSet.includes(m);
  const diskIo = metricSet.filter((m) => m.startsWith("disk_read") || m.startsWith("disk_write"));
  const others = metricSet.filter((m) => !KNOWN.has(m) && !diskIo.includes(m));
  const refetch = range === "15m" || range === "1h" ? interval : false;
  const ids = [resource.id];
  const common = { resourceIds: ids, range, refetchInterval: refetch };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Metrics range" value={range} options={RANGES} onChange={setRange} />
        <span className="text-xs text-muted-foreground">{metricSet.length} metrics reported in the last 7 days</span>
      </div>
      {names.isLoading ? null : !metricSet.length ? (
        <Card><EmptyState title="No metrics yet" description="Metrics appear once the agent starts reporting." /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {has("cpu_percent") && <MetricChart title="CPU utilization" metrics={[{ metric: "cpu_percent", label: "CPU" }]} valueFormatter={pct} yMax={100} {...common} />}
          {has("memory_percent") && <MetricChart title="Memory utilization" metrics={[{ metric: "memory_percent", label: "Memory" }]} valueFormatter={pct} yMax={100} {...common} />}
          {(has("load1") || has("load5") || has("load15")) && (
            <MetricChart title="Load average" metrics={["load1", "load5", "load15"].filter(has).map((m) => ({ metric: m, label: m }))}
              valueFormatter={(v) => v.toFixed(2)} {...common} />
          )}
          {has("disk_percent") && <MetricChart title="Disk usage by mount" metrics={[{ metric: "disk_percent", label: "Disk" }]} valueFormatter={pct} yMax={100} {...common} />}
          {diskIo.length > 0 && (
            <MetricChart title="Disk I/O" metrics={diskIo.map((m) => ({ metric: m, label: m.replace(/^disk_/, "").replace(/_/g, " ") }))}
              valueFormatter={(v) => (/bytes/.test(diskIo.join()) ? bytesPs(v) : formatNumber(v, 1))} {...common} />
          )}
          {(has("net_rx_bytes_ps") || has("net_tx_bytes_ps")) && (
            <MetricChart title="Network traffic by interface" kind="area"
              metrics={[{ metric: "net_rx_bytes_ps", label: "rx" }, { metric: "net_tx_bytes_ps", label: "tx" }].filter((m) => has(m.metric))}
              valueFormatter={bytesPs} {...common} />
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-col gap-3">
          <Field label="Other metric" htmlFor="other-metric" className="max-w-xs">
            <NativeSelect id="other-metric" value={extra} onChange={(e) => setExtra(e.target.value)}>
              <option value="">Select a metric…</option>
              {others.map((m) => <option key={m} value={m}>{m}</option>)}
            </NativeSelect>
          </Field>
          {extra && <MetricChart title={extra} metrics={[{ metric: extra }]} valueFormatter={(v) => formatNumber(v, 2)} {...common} />}
        </div>
      )}
    </div>
  );
}

function AgentTab({ resource }: { resource: Resource }) {
  const canManage = useCan("agents:manage");
  const agent = resource.agent;
  const [description, setDescription] = React.useState(`Agent for ${resource.name}`);
  const [hours, setHours] = React.useState("24");
  const [created, setCreated] = React.useState<EnrollmentTokenCreated | null>(null);
  const [confirmRevoke, setConfirmRevoke] = React.useState(false);
  const create = useApiMutation({
    mutationFn: () => agentsApi.createToken({ server_id: resource.id, description, expires_in_hours: Number(hours) }),
    success: "Enrollment token created",
    invalidate: [qk.enrollmentTokens],
    onSuccess: (t) => setCreated(t),
  });
  const revoke = useApiMutation({
    mutationFn: () => agentsApi.revoke(agent?.id ?? ""),
    success: "Agent credentials revoked",
    invalidate: [qk.resources, qk.agents],
    onSuccess: () => setConfirmRevoke(false),
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Agent</CardTitle>
          {agent && <StatusBadge status={agent.status === "active" ? (resource.status === "unreachable" ? "unreachable" : "healthy") : agent.status} />}
        </CardHeader>
        <CardContent>
          {!agent ? (
            <EmptyState title="No agent enrolled" description="Create an enrollment token and run the install command on this server." />
          ) : (
            <div className="flex flex-col gap-4">
              <DefinitionList items={[
                ["Status", humanize(agent.status)],
                ["Version", agent.version],
                ["Last seen", <RelativeTime key="ls" value={agent.last_seen_at} />],
                ["Last IP", <span key="ip" className="font-mono text-xs">{agent.last_ip}</span>],
                ["Collection interval", `${agent.collection_interval_seconds}s`],
                ["Spooled batches", String(agent.spool_depth)],
                ["Enrolled", formatDateTime(agent.enrolled_at)],
                ["Last error", agent.last_error ? <span key="e" className="text-destructive">{agent.last_error}</span> : "none"],
              ]} />
              {canManage && agent.status !== "revoked" && (
                <div>
                  <Button variant="destructive" onClick={() => setConfirmRevoke(true)}><ShieldOff /> Revoke agent</Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {canManage && (
        <Card>
          <CardHeader><CardTitle>{agent ? "Re-enroll agent" : "Install the agent"}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Generate a single-use token bound to this server. {agent ? "Re-enrolling replaces the current agent credentials (add --reenroll to the command)." : ""}
              {" "}See the <Link className="underline" to="/agents/install">installation guide</Link> for requirements and troubleshooting.
            </p>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <Field label="Description" htmlFor="tok-desc" className="min-w-[200px] flex-1">
                <Input id="tok-desc" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field label="Expires in" htmlFor="tok-exp">
                <NativeSelect id="tok-exp" value={hours} onChange={(e) => setHours(e.target.value)}>
                  <option value="1">1 hour</option>
                  <option value="24">24 hours</option>
                  <option value="168">7 days</option>
                  <option value="720">30 days</option>
                </NativeSelect>
              </Field>
              <Button type="submit" loading={create.isPending}><KeyRound /> Create token</Button>
            </form>
            {created && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <AlertTriangle className="size-4 text-amber-500" aria-hidden /> Copy this token now — it is shown only once.
                </p>
                <span className="text-xs text-muted-foreground">Token (expires {formatDateTime(created.expires_at)})</span>
                <CodeBlock code={created.token} />
                <span className="text-xs text-muted-foreground">Run on the server (as a user with sudo) — it downloads, enrolls and starts the agent:</span>
                <CodeBlock code={created.install_command} />
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={confirmRevoke} onOpenChange={setConfirmRevoke} title="Revoke agent credentials?" destructive confirmLabel="Revoke"
        description="The agent can no longer send metrics or logs until it is re-enrolled." loading={revoke.isPending} onConfirm={() => revoke.mutate()} />
    </div>
  );
}

function ServerSettingsCard({ resource }: { resource: Resource }) {
  const canWrite = useCan("resources:write");
  const sd = resource.server;
  const init = React.useCallback((): ServerFieldsDraft => ({
    hostname: sd?.hostname ?? "",
    ip_address: sd?.ip_address ?? "",
    os_family: (sd?.os_family === "windows" || sd?.os_family === "other" ? sd.os_family : "linux"),
    os_version: sd?.os_version ?? "",
    monitoring_interval_seconds: String(sd?.monitoring_interval_seconds ?? 30),
    agent_timeout_seconds: sd?.agent_timeout_seconds ? String(sd.agent_timeout_seconds) : "",
  }), [sd]);
  const [fields, setFields] = React.useState<ServerFieldsDraft>(init);
  const [thresholds, setThresholds] = React.useState(() => thresholdsToDraft(sd?.thresholds));
  const [services, setServices] = React.useState<string[]>(sd?.monitored_services ?? []);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    setFields(init());
    setThresholds(thresholdsToDraft(sd?.thresholds));
    setServices(sd?.monitored_services ?? []);
  }, [init, sd]);

  const save = useApiMutation({
    mutationFn: () => {
      const errs: Record<string, string> = {};
      const { interval, timeout } = parseServerNumbers(fields, errs);
      const th = draftToThresholds(thresholds, errs);
      setErrors(errs);
      if (Object.keys(errs).length) throw new Error("Please fix the highlighted fields");
      return serversApi.update(resource.id, {
        hostname: fields.hostname.trim(),
        ip_address: fields.ip_address.trim(),
        os_family: fields.os_family,
        os_version: fields.os_version.trim(),
        monitoring_interval_seconds: interval,
        ...(timeout !== null ? { agent_timeout_seconds: timeout } : {}),
        thresholds: th,
        monitored_services: services,
      });
    },
    success: "Server settings saved",
    invalidate: [qk.resources],
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  if (!sd) return <InlineError error={new Error("Server details unavailable")} />;
  return (
    <Card>
      <CardHeader><CardTitle>Server settings & thresholds</CardTitle></CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} noValidate>
          <fieldset disabled={!canWrite} className="flex flex-col gap-4">
            <ServerFields value={fields} onChange={setFields} errors={errors} idPrefix="ss" />
            <Field label="Monitored services" htmlFor="ss-services" error={errors.monitored_services}>
              <TagInput id="ss-services" value={services} onChange={setServices} />
            </Field>
            <div>
              <p className="mb-2 text-xs font-medium">Per-server alert thresholds <span className="font-normal text-muted-foreground">(empty = organization default)</span></p>
              <ThresholdsEditor value={thresholds} onChange={setThresholds} errors={errors} idPrefix="ss-th" />
            </div>
          </fieldset>
          {canWrite && <div><Button type="submit" loading={save.isPending}>Save server settings</Button></div>}
        </form>
      </CardContent>
    </Card>
  );
}

export function ServerDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && (TABS as readonly string[]).includes(tabParam) ? tabParam : "overview";
  const query = useResource(id);
  return (
    <DetailState query={query}>
      {(r) => (
        <div>
          <ResourceHeader resource={r} backTo="/servers" backLabel="Servers" />
          <Tabs value={tab} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", v); return n; }, { replace: true })}>
            <TabsList aria-label="Server sections">
              {TABS.map((t) => <TabsTrigger key={t} value={t}>{humanize(t)}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="overview"><OverviewTab resource={r} /></TabsContent>
            <TabsContent value="metrics"><MetricsTab resource={r} /></TabsContent>
            <TabsContent value="checks"><ChecksPanel resource={r} defaultType="icmp" /></TabsContent>
            <TabsContent value="incidents"><ResourceIncidentsPanel resourceId={r.id} /></TabsContent>
            <TabsContent value="logs"><ResourceLogsPanel resourceId={r.id} /></TabsContent>
            <TabsContent value="events"><ResourceEventsPanel resourceId={r.id} /></TabsContent>
            <TabsContent value="agent"><AgentTab resource={r} /></TabsContent>
            <TabsContent value="settings">
              <ResourceSettingsPanel resource={r} backTo="/servers" extra={<ServerSettingsCard resource={r} />} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </DetailState>
  );
}
