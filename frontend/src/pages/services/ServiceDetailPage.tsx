import { Zap } from "lucide-react";
import * as React from "react";
import { useParams } from "react-router-dom";
import { checksApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { TimeChart } from "@/components/charts";
import { RelativeTime, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useCan } from "@/features/auth/AuthProvider";
import { CHECK_TYPE_LABELS } from "@/features/checks/checkSpecs";
import { ChecksPanel, DetailState, ResourceEventsPanel, ResourceHeader, ResourceIncidentsPanel, ResourceLogsPanel, ResourceMetaCard, ResourceSettingsPanel, useResource } from "@/features/resources/panels";
import { useApiMutation } from "@/hooks/useApi";
import { AvailabilityStats, CheckResultsCard, DETAIL_RANGES, type DetailRange, latencyRows, useAvailability, useCheckTimeseries } from "@/pages/services/detailShared";
import type { Check, Resource } from "@/types/api";
import { formatMs, formatPercent } from "@/utils/format";
import { resourcePath } from "@/utils/status";

function CheckCard({ check, range, uptime, onSelect, selected }: {
  check: Check;
  range: DetailRange;
  uptime: number | null | undefined;
  onSelect: () => void;
  selected: boolean;
}) {
  const ts = useCheckTimeseries(check.id, range);
  return (
    <Card className={selected ? "border-primary/60" : undefined}>
      <CardHeader>
        <button type="button" onClick={onSelect} className="min-w-0 text-left hover:underline" aria-pressed={selected}>
          <CardTitle className="truncate">{check.name}</CardTitle>
          <span className="text-xs text-muted-foreground">{CHECK_TYPE_LABELS[check.type] ?? check.type}</span>
        </button>
        <StatusBadge status={check.enabled ? check.state : "unknown"} />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div><p className="text-muted-foreground">Latency</p><p className="tabular font-medium">{formatMs(check.last_latency_ms)}</p></div>
          <div><p className="text-muted-foreground">Uptime</p><p className="tabular font-medium">{formatPercent(uptime, 2)}</p></div>
          <div><p className="text-muted-foreground">Last run</p><p className="font-medium"><RelativeTime value={check.last_run_at} /></p></div>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={check.last_message}>{check.last_message || "No result yet"}</p>
        {ts.isLoading ? <LoadingState className="py-4" /> : ts.isError ? <ErrorState error={ts.error} className="py-2" /> : (
          <TimeChart ariaLabel={`${check.name} latency`} data={latencyRows(ts.data?.points ?? [])} series={[{ key: "avg_ms", label: "Avg latency" }]}
            height={90} kind="area" showLegend={false} valueFormatter={(v) => `${Math.round(v)} ms`} emptyText="No data" />
        )}
      </CardContent>
    </Card>
  );
}

function OverviewTab({ resource, range }: { resource: Resource; range: DetailRange }) {
  const av = useAvailability(resource.id, range);
  const checks = resource.checks ?? [];
  const [selected, setSelected] = React.useState<string | null>(checks[0]?.id ?? null);
  const sel = checks.find((c) => c.id === selected) ?? checks[0];
  return (
    <div className="flex flex-col gap-4">
      {av.isLoading ? <LoadingState /> : av.isError ? <ErrorState error={av.error} onRetry={() => void av.refetch()} /> : (
        <AvailabilityStats av={av.data?.resource ?? null} />
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:col-span-2">
          {checks.length ? checks.map((c) => (
            <CheckCard key={c.id} check={c} range={range} selected={sel?.id === c.id} onSelect={() => setSelected(c.id)}
              uptime={av.data?.checks.find((x) => x.check_id === c.id)?.uptime_percent} />
          )) : <p className="text-sm text-muted-foreground">No checks configured. Add one in the Checks tab.</p>}
        </div>
        <ResourceMetaCard resource={resource} />
      </div>
      {sel && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Results — {sel.name}</h2>
          <CheckResultsCard checkId={sel.id} range={range} http={sel.type === "http"} />
        </div>
      )}
    </div>
  );
}

/** Generic resource detail, used for services, databases, applications and as fallback for any kind. */
export function ServiceDetailPage() {
  const { id } = useParams();
  const query = useResource(id);
  const [range, setRange] = React.useState<DetailRange>("24h");
  const canWrite = useCan("resources:write");
  const run = useApiMutation({ mutationFn: (cid: string) => checksApi.run(cid), success: (m) => m.message, invalidate: [qk.resources] });
  return (
    <DetailState query={query}>
      {(r) => {
        const back = resourcePath(r.kind, "").replace(/\/$/, "");
        return (
          <div>
            <ResourceHeader resource={r} backTo={back} backLabel="Back to list"
              actions={
                <>
                  <Segmented label="Time range" value={range} options={DETAIL_RANGES} onChange={setRange} />
                  {canWrite && (r.checks?.length ?? 0) > 0 && (
                    <Button size="sm" variant="outline" loading={run.isPending}
                      onClick={() => (r.checks ?? []).filter((c) => c.enabled).forEach((c) => run.mutate(c.id))}>
                      <Zap /> Run all checks
                    </Button>
                  )}
                </>
              } />
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="checks">Checks</TabsTrigger>
                <TabsTrigger value="incidents">Incidents</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="events">Events</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="overview"><OverviewTab resource={r} range={range} /></TabsContent>
              <TabsContent value="checks"><ChecksPanel resource={r} /></TabsContent>
              <TabsContent value="incidents"><ResourceIncidentsPanel resourceId={r.id} /></TabsContent>
              <TabsContent value="logs"><ResourceLogsPanel resourceId={r.id} /></TabsContent>
              <TabsContent value="events"><ResourceEventsPanel resourceId={r.id} /></TabsContent>
              <TabsContent value="settings"><ResourceSettingsPanel resource={r} backTo={back} /></TabsContent>
            </Tabs>
          </div>
        );
      }}
    </DetailState>
  );
}
