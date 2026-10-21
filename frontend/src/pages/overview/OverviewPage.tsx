import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { checksApi, dashboardApi, incidentsApi, resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { MeterCell, TimeChart, type ChartRow } from "@/components/charts";
import { PageHeader, RelativeTime, SeverityBadge, Stat, StatusBadge, StatusDot } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { ENVIRONMENTS, type DashboardTrends } from "@/types/api";
import { formatBits, formatDateTime, formatMs, formatPercent, humanize, rangeToSeconds, toDate } from "@/utils/format";
import { LOG_SEVERITY_COLORS, SEVERITY_STYLES, resourcePath } from "@/utils/status";
import { incidentTrend, mergeAvailability, trendBucketSeconds } from "@/pages/overview/trendsFallback";

type Range = "24h" | "7d" | "30d";
const REFRESH_MS = 30000;

/** Trends from the API, falling back to a client-side computation when the endpoint fails. */
function useTrends(range: Range, environment: string) {
  const trends = useQuery({
    queryKey: qk.dashboardPart("trends", { range, environment }),
    queryFn: () => dashboardApi.trends({ range, environment }),
    refetchInterval: REFRESH_MS * 2,
    retry: false,
  });
  const fallback = useQuery({
    queryKey: qk.dashboardPart("trends-fallback", { range, environment }),
    enabled: trends.isError,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async (): Promise<DashboardTrends> => {
      const end = new Date();
      const secs = rangeToSeconds(range);
      const start = new Date(end.getTime() - secs * 1000);
      const bucket = trendBucketSeconds(secs);
      const [incidents, resources] = await Promise.all([
        incidentsApi.list({ start: start.toISOString(), page_size: 500 }),
        resourcesApi.list({ page_size: 200, environment }),
      ]);
      const checks = resources.items.flatMap((r) => (r.checks ?? []).filter((c) => c.enabled)).slice(0, 25);
      const series = await Promise.all(checks.map((c) =>
        checksApi.timeseries(c.id, { range, bucket: Math.max(bucket, 60) }).then((t) => t.points).catch(() => [])));
      return {
        bucket_seconds: bucket,
        incidents: incidentTrend(incidents.items, start, end, bucket),
        availability: mergeAvailability(series),
      };
    },
  });
  const usingFallback = trends.isError;
  return {
    data: usingFallback ? fallback.data : trends.data,
    isLoading: trends.isLoading || (usingFallback && fallback.isLoading),
    error: usingFallback ? fallback.error : null,
    isError: usingFallback && fallback.isError,
    usingFallback,
    refetch: () => (usingFallback ? fallback.refetch() : trends.refetch()),
  };
}

function ChartCard({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {note}
      </CardHeader>
      <div className="p-3">{children}</div>
    </Card>
  );
}

export function OverviewPage() {
  const canLogs = useCan("logs:read");
  const [range, setRange] = React.useState<Range>("24h");
  const [environment, setEnvironment] = React.useState("");

  const summary = useQuery({
    queryKey: qk.dashboardPart("summary", { environment }),
    queryFn: () => dashboardApi.summary({ environment }),
    refetchInterval: REFRESH_MS,
  });
  const trends = useTrends(range, environment);
  const traffic = useQuery({
    queryKey: qk.dashboardPart("traffic", { range, environment }),
    queryFn: () => dashboardApi.traffic({ range, environment }),
    refetchInterval: REFRESH_MS * 2,
  });
  const activity = useQuery({ queryKey: qk.dashboardPart("activity"), queryFn: () => dashboardApi.activity(30), refetchInterval: REFRESH_MS });
  const logErrors = useQuery({
    queryKey: qk.dashboardPart("log-errors"),
    queryFn: () => dashboardApi.logErrors(10),
    enabled: canLogs,
    refetchInterval: REFRESH_MS,
  });

  const incidentRows: ChartRow[] = (trends.data?.incidents ?? []).map((p) => ({
    t: toDate(p.ts)?.getTime() ?? 0, critical: p.critical, high: p.high, warning: p.warning, info: p.info,
  }));
  const availabilityRows: ChartRow[] = (trends.data?.availability ?? []).map((p) => ({
    t: toDate(p.ts)?.getTime() ?? 0, uptime: p.uptime_percent, avg_ms: p.avg_ms,
  }));
  const trafficRows: ChartRow[] = (traffic.data?.points ?? []).map((p) => ({ t: toDate(p.ts)?.getTime() ?? 0, rx: p.rx_bps, tx: p.tx_bps }));

  const fallbackNote = trends.usingFallback
    ? <span className="text-[11px] text-muted-foreground">Computed in browser (trends endpoint unavailable)</span>
    : undefined;

  const s = summary.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        description={s ? <>Updated <RelativeTime value={s.generated_at} /> · auto-refresh every 30s</> : "Infrastructure health at a glance"}
        actions={
          <>
            <NativeSelect aria-label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value)} className="w-40">
              <option value="">All environments</option>
              {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
            </NativeSelect>
            <Segmented label="Time range" value={range} options={["24h", "7d", "30d"] as const} onChange={setRange} />
            <Button variant="outline" size="icon" aria-label="Refresh dashboard"
              onClick={() => { void summary.refetch(); void trends.refetch(); void traffic.refetch(); void activity.refetch(); }}>
              <RefreshCw />
            </Button>
          </>
        }
      />

      {summary.isLoading ? <LoadingState label="Loading summary…" /> : summary.isError ? (
        <Card><ErrorState error={summary.error} onRetry={() => void summary.refetch()} /></Card>
      ) : s && (
        <>
          <section aria-label="Servers summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Servers" value={s.servers.total} to="/servers" sub={`${s.network_devices.total} network devices`} />
            <Stat label="Healthy servers" value={s.servers.healthy} tone="good" to="/servers?status=healthy" />
            <Stat label="Warning" value={s.servers.warning} tone={s.servers.warning ? "warn" : "default"} to="/servers?status=warning" />
            <Stat label="Critical" value={s.servers.critical} tone={s.servers.critical ? "bad" : "default"} to="/servers?status=critical" />
            <Stat label="Unreachable" value={s.servers.unreachable} tone={s.servers.unreachable ? "purple" : "default"} to="/servers?status=unreachable" />
            <Stat label="Services" value={s.services.total} to="/services" sub={`${s.services.critical + s.services.unreachable} failing`} />
          </section>
          <section aria-label="Websites and incidents summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Websites" value={s.websites.total} to="/websites" sub={`${s.websites.down} down`} />
            <Stat label="Websites down" value={s.websites.down} tone={s.websites.down ? "bad" : "good"} to="/websites?status=critical" />
            <Stat label="Uptime 24h" value={formatPercent(s.websites.uptime_24h, 2)} tone="info" to="/reports?report=website-uptime&range=24h"
              sub={`avg ${formatMs(s.websites.avg_response_ms_24h)}`} />
            <Stat label="Open incidents" value={s.incidents.open} tone={s.incidents.open ? "warn" : "good"} to="/incidents?open=true" />
            <Stat label="Critical incidents" value={s.incidents.critical_open} tone={s.incidents.critical_open ? "bad" : "default"}
              to="/incidents?open=true&severity=critical" />
            <Stat label="Incidents today" value={s.incidents.triggered_today} to="/incidents"
              sub={`${s.incidents.notifications_sent_today} alerts sent`} />
          </section>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Incident trend" note={fallbackNote}>
          {trends.isLoading ? <LoadingState /> : trends.isError ? <ErrorState error={trends.error} onRetry={() => void trends.refetch()} /> : (
            <TimeChart ariaLabel="Incidents by severity over time" kind="stacked-bar" data={incidentRows}
              series={(["critical", "high", "warning", "info"] as const).map((k) => ({ key: k, label: humanize(k), color: SEVERITY_STYLES[k].fill }))}
              valueFormatter={(v) => String(Math.round(v))} emptyText="No incidents in this range" />
          )}
        </ChartCard>
        <ChartCard title="Availability trend" note={fallbackNote}>
          {trends.isLoading ? <LoadingState /> : trends.isError ? <ErrorState error={trends.error} onRetry={() => void trends.refetch()} /> : (
            <TimeChart ariaLabel="Availability percent over time" data={availabilityRows.filter((r) => r.uptime !== null)}
              series={[{ key: "uptime", label: "Uptime %", color: "#10b981" }]} yDomain={["auto", 100]}
              valueFormatter={(v) => `${v.toFixed(1)}%`} emptyText="No check results in this range" />
          )}
        </ChartCard>
        <ChartCard title="Network traffic (servers & devices)">
          {traffic.isLoading ? <LoadingState /> : traffic.isError ? <ErrorState error={traffic.error} onRetry={() => void traffic.refetch()} /> : (
            <TimeChart ariaLabel="Network traffic receive and transmit" kind="area" data={trafficRows}
              series={[{ key: "rx", label: "Receive", color: "#3b82f6" }, { key: "tx", label: "Transmit", color: "#8b5cf6" }]}
              valueFormatter={formatBits} emptyText="No network metrics reported yet" />
          )}
        </ChartCard>
        <Card>
          <CardHeader><CardTitle>Server resource usage</CardTitle><Link to="/servers" className="text-xs text-primary hover:underline">All servers</Link></CardHeader>
          {!s ? <LoadingState /> : !s.server_overview.length ? (
            <EmptyState title="No servers" description="Add a server and install the agent to see CPU, memory and disk usage." />
          ) : (
            <div className="max-h-[260px] overflow-y-auto">
              <Table>
                <THead><TR><TH>Server</TH><TH>CPU</TH><TH>Memory</TH><TH>Disk (max)</TH><TH>Load</TH></TR></THead>
                <TBody>
                  {[...s.server_overview].sort((a, b) => (b.cpu_percent ?? -1) - (a.cpu_percent ?? -1)).map((r) => (
                    <TR key={r.id}>
                      <TD><Link to={`/servers/${r.id}`} className="flex items-center gap-2 hover:underline"><StatusDot status={r.status} />{r.name}</Link></TD>
                      <TD><MeterCell value={r.cpu_percent} /></TD>
                      <TD><MeterCell value={r.memory_percent} warn={85} crit={95} /></TD>
                      <TD><MeterCell value={r.disk_percent_max} /></TD>
                      <TD className="tabular text-xs">{r.load1 ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Recent monitoring failures</CardTitle></CardHeader>
          {!s ? <LoadingState /> : !s.recent_failures.length ? <EmptyState title="All checks passing" description="No enabled check is currently down." /> : (
            <ul className="divide-y">
              {s.recent_failures.map((f) => (
                <li key={f.check_id} className="px-4 py-2">
                  <Link to={resourcePath(f.kind, f.resource_id)} className="flex items-center gap-2 text-sm font-medium hover:underline">
                    <StatusDot status="down" /> {f.resource} <span className="text-xs font-normal text-muted-foreground">· {f.check}</span>
                  </Link>
                  <p className="truncate text-xs text-muted-foreground" title={f.message}>{f.message || "Check failing"}</p>
                  <p className="text-[11px] text-muted-foreground">down since <RelativeTime value={f.since} /></p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent log errors (24h)</CardTitle>{canLogs && <Link to="/logs?min_severity=error&range=24h" className="text-xs text-primary hover:underline">Open logs</Link>}</CardHeader>
          {!canLogs ? <EmptyState title="No access to logs" description="Your role does not include log access." /> :
            logErrors.isLoading ? <LoadingState /> : logErrors.isError ? <ErrorState error={logErrors.error} onRetry={() => void logErrors.refetch()} /> :
              !logErrors.data?.length ? <EmptyState title="No errors logged in the last 24 hours" /> : (
                <ul className="divide-y">
                  {logErrors.data.map((l) => (
                    <li key={l.id} className="px-4 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold uppercase" style={{ color: LOG_SEVERITY_COLORS[l.severity] }}>{l.severity}</span>
                        <span className="text-muted-foreground">{l.host || l.application || l.source}</span>
                        <span className="ml-auto text-muted-foreground"><RelativeTime value={l.ts} /></span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 break-all font-mono">{l.message}</p>
                    </li>
                  ))}
                </ul>
              )}
        </Card>
        <Card>
          <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
          {activity.isLoading ? <LoadingState /> : activity.isError ? <ErrorState error={activity.error} onRetry={() => void activity.refetch()} /> :
            !activity.data?.length ? <EmptyState title="No activity in the last 3 days" /> : (
              <ul className="max-h-[360px] divide-y overflow-y-auto">
                {activity.data.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{e.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        <Badge variant="outline" className="mr-1">{humanize(e.kind)}</Badge>
                        <span title={formatDateTime(e.ts, { seconds: true })}><RelativeTime value={e.ts} /></span>
                      </p>
                    </div>
                    {e.severity && (["critical", "high", "warning", "info"].includes(e.severity)
                      ? <SeverityBadge severity={e.severity} /> : <StatusBadge status={e.severity} />)}
                  </li>
                ))}
              </ul>
            )}
        </Card>
      </div>
    </div>
  );
}
