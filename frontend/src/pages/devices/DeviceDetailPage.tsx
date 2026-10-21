import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import * as React from "react";
import { useParams } from "react-router-dom";
import { checksApi, metricsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { mergeSeries, TimeChart } from "@/components/charts";
import { DefinitionList, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { ChecksPanel, DetailState, ResourceEventsPanel, ResourceHeader, ResourceIncidentsPanel, ResourceLogsPanel, ResourceMetaCard, ResourceSettingsPanel } from "@/features/resources/panels";
import { useResource } from "@/features/resources/panels";
import { useApiMutation } from "@/hooks/useApi";
import { AvailabilityStats, pickAvailability, useAvailability } from "@/pages/services/detailShared";
import type { Check, JsonValue, Resource } from "@/types/api";
import { formatBits, formatBytes, formatMs, formatNumber, formatPercent, humanize } from "@/utils/format";

type Range = "1h" | "6h" | "24h" | "7d" | "30d";
const RANGES: readonly Range[] = ["1h", "6h", "24h", "7d", "30d"];

function MetricChart({ resourceId, metric, range, title, format, available, perInstance, kind = "line" }: {
  resourceId: string;
  metric: string;
  range: Range;
  title: string;
  format: (v: number) => string;
  available: boolean;
  perInstance?: boolean;
  kind?: "line" | "area";
}) {
  const q = useQuery({
    queryKey: qk.metricSeries({ resource_id: resourceId, metric, range }),
    queryFn: () => metricsApi.series({ resource_id: [resourceId], metric, range }),
    enabled: available,
  });
  const series = (q.data?.series ?? []).map((s, i) => ({
    key: `s${i}`,
    label: perInstance || s.instance ? s.instance || metric : title,
    points: s.points,
  }));
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {!available ? <EmptyState title="No data reported for this metric" className="py-6" />
          : q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
            <TimeChart ariaLabel={`${title} chart`} data={mergeSeries(series)} series={series.map((s) => ({ key: s.key, label: s.label }))}
              valueFormatter={format} kind={kind} />
          )}
      </CardContent>
    </Card>
  );
}

type Row = Record<string, JsonValue>;

function interfacesOf(check: Check | undefined): Row[] {
  const raw = check?.last_details?.interfaces;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is Row => Boolean(x) && typeof x === "object" && !Array.isArray(x));
  if (typeof raw === "object") {
    return Object.entries(raw).map(([k, v]): Row => (v && typeof v === "object" && !Array.isArray(v) ? { name: k, ...(v as Row) } : { name: k, value: v ?? null }));
  }
  return [];
}

const PREFERRED = ["name", "descr", "description", "alias", "oper_status", "admin_status", "speed", "speed_bps", "in_octets",
  "out_octets", "in_bps", "out_bps", "rx_bytes_ps", "tx_bytes_ps", "in_errors", "out_errors", "in_discards", "out_discards"];

function cellValue(key: string, v: JsonValue): React.ReactNode {
  if (v === null || v === undefined || v === "") return "—";
  if (key.includes("status")) return <StatusBadge status={String(v) === "up" || v === 1 ? "up" : String(v) === "down" || v === 2 ? "down" : String(v)} />;
  if (typeof v === "number") {
    if (/bps$/.test(key) || key.startsWith("speed")) return formatBits(key.includes("bytes") ? v * 8 : v);
    if (key.includes("bytes_ps")) return formatBits(v * 8);
    if (key.includes("octets")) return formatBytes(v);
    if (key.includes("percent") || key.includes("util")) return formatPercent(v);
    return formatNumber(v, 2);
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function InterfaceTable({ check }: { check: Check | undefined }) {
  const rows = interfacesOf(check);
  if (!check) return <EmptyState title="SNMP is not configured" description="Add an SNMP check in the Checks tab to collect interface statistics." />;
  if (!rows.length) return <EmptyState title="No interface data yet" description={check.last_message || "Interface statistics appear after the first successful SNMP poll."} />;
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cols = [...PREFERRED.filter((k) => keys.includes(k)), ...keys.filter((k) => !PREFERRED.includes(k))].slice(0, 12);
  return (
    <Table>
      <THead><TR>{cols.map((c) => <TH key={c}>{humanize(c)}</TH>)}</TR></THead>
      <TBody>
        {rows.map((r, i) => (
          <TR key={String(r.name ?? r.index ?? i)}>
            {cols.map((c) => <TD key={c} className="tabular whitespace-nowrap text-xs">{cellValue(c, r[c] ?? null)}</TD>)}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function OverviewTab({ resource, range }: { resource: Resource; range: Range }) {
  const names = useQuery({ queryKey: qk.metricNames(resource.id), queryFn: () => metricsApi.names(resource.id) });
  const av = useAvailability(resource.id, range);
  const has = (m: string) => (names.data ?? []).some((n) => n.metric === m);
  const ping = resource.checks?.find((c) => c.type === "icmp");
  const snmp = resource.checks?.find((c) => c.type === "snmp");
  const a = resource.attributes;
  const str = (k: string) => (typeof a[k] === "string" ? String(a[k]) : "");
  return (
    <div className="flex flex-col gap-4">
      {av.isLoading ? <LoadingState /> : av.isError ? <ErrorState error={av.error} /> : (
        <AvailabilityStats av={pickAvailability(av.data?.resource, av.data?.checks.find((c) => c.check_id === ping?.id))} />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Device</CardTitle></CardHeader>
          <CardContent>
            <DefinitionList items={[
              ["Vendor", str("vendor")],
              ["Model", str("model")],
              ["Type", humanize(str("device_type"))],
              ["Ping", ping ? <span className="flex items-center gap-2"><StatusBadge status={ping.state} /> {formatMs(ping.last_latency_ms)}</span> : "disabled"],
              ["SNMP", snmp ? <span className="flex items-center gap-2"><StatusBadge status={snmp.state} /> v{String(snmp.config.version ?? "2c")}</span> : "not configured"],
              ["Last SNMP message", snmp?.last_message ?? ""],
            ]} />
          </CardContent>
        </Card>
        <div className="xl:col-span-2"><ResourceMetaCard resource={resource} /></div>
      </div>
      {names.isError ? <ErrorState error={names.error} /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <MetricChart resourceId={resource.id} metric="ping_rtt_ms" range={range} title="Latency (RTT)" available={has("ping_rtt_ms")}
            format={(v) => `${v.toFixed(1)} ms`} />
          <MetricChart resourceId={resource.id} metric="packet_loss_percent" range={range} title="Packet loss" available={has("packet_loss_percent")}
            format={(v) => `${v.toFixed(0)}%`} kind="area" />
          <MetricChart resourceId={resource.id} metric="net_rx_bytes_ps" range={range} title="Interface traffic in" available={has("net_rx_bytes_ps")}
            format={(v) => formatBits(v * 8)} perInstance />
          <MetricChart resourceId={resource.id} metric="net_tx_bytes_ps" range={range} title="Interface traffic out" available={has("net_tx_bytes_ps")}
            format={(v) => formatBits(v * 8)} perInstance />
        </div>
      )}
      <Card>
        <CardHeader><CardTitle>Interfaces</CardTitle></CardHeader>
        <InterfaceTable check={snmp} />
      </Card>
    </div>
  );
}

export function DeviceDetailPage() {
  const { id } = useParams();
  const query = useResource(id);
  const [range, setRange] = React.useState<Range>("24h");
  const canWrite = useCan("resources:write");
  const run = useApiMutation({ mutationFn: (cid: string) => checksApi.run(cid), success: (m) => m.message, invalidate: [qk.resources] });
  return (
    <DetailState query={query}>
      {(r) => (
        <div>
          <ResourceHeader resource={r} backTo="/network-devices" backLabel="Network devices"
            actions={
              <>
                <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
                {canWrite && (r.checks ?? []).filter((c) => c.enabled).map((c) => (
                  <Button key={c.id} size="sm" variant="outline" onClick={() => run.mutate(c.id)}><Zap /> Run {c.name}</Button>
                ))}
              </>
            } />
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="checks">Checks</TabsTrigger>
              <TabsTrigger value="incidents">Incidents</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="overview"><OverviewTab resource={r} range={range} /></TabsContent>
            <TabsContent value="checks"><ChecksPanel resource={r} defaultType="snmp" /></TabsContent>
            <TabsContent value="incidents"><ResourceIncidentsPanel resourceId={r.id} /></TabsContent>
            <TabsContent value="events"><ResourceEventsPanel resourceId={r.id} /></TabsContent>
            <TabsContent value="logs"><ResourceLogsPanel resourceId={r.id} /></TabsContent>
            <TabsContent value="settings"><ResourceSettingsPanel resource={r} backTo="/network-devices" /></TabsContent>
          </Tabs>
        </div>
      )}
    </DetailState>
  );
}
