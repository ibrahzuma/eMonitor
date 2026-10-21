import { useQueries } from "@tanstack/react-query";
import { metricsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { TimeChart, mergeSeries } from "@/components/charts";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";

export interface MetricRef {
  metric: string;
  label?: string;
}

/**
 * Chart one or more metrics for one or more resources. Every (resource, metric, instance) combination
 * becomes its own series. `resourceNames` labels series when comparing several resources.
 */
export function MetricChart({ title, resourceIds, metrics, range, valueFormatter, resourceNames, height = 200, yMax,
  refetchInterval, kind = "line" }: {
  title: string;
  resourceIds: string[];
  metrics: MetricRef[];
  range: string;
  valueFormatter?: (v: number) => string;
  resourceNames?: Record<string, string>;
  height?: number;
  yMax?: number;
  refetchInterval?: number | false;
  kind?: "line" | "area";
}) {
  const results = useQueries({
    queries: metrics.map((m) => {
      const q = { resource_id: resourceIds, metric: m.metric, range };
      return {
        queryKey: qk.metricSeries(q),
        queryFn: () => metricsApi.series(q),
        enabled: resourceIds.length > 0,
        refetchInterval,
      };
    }),
  });
  const loading = results.some((r) => r.isLoading);
  const failed = results.find((r) => r.isError);
  const multiResource = resourceIds.length > 1;
  const series: { key: string; label: string; points: [string, number][] }[] = [];
  results.forEach((r, i) => {
    const m = metrics[i];
    for (const s of r.data?.series ?? []) {
      const parts = [
        multiResource ? (resourceNames?.[s.resource_id] ?? s.resource_id.slice(0, 8)) : null,
        metrics.length > 1 || !s.instance ? (m.label ?? m.metric) : null,
        s.instance || null,
      ].filter(Boolean);
      series.push({ key: `${s.resource_id}|${m.metric}|${s.instance}`, label: parts.join(" · ") || m.metric, points: s.points });
    }
  });
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <div className="p-3">
        {loading ? <LoadingState /> : failed ? <ErrorState error={failed.error} onRetry={() => results.forEach((r) => void r.refetch())} /> : (
          <TimeChart ariaLabel={`${title} chart`} kind={kind} height={height} data={mergeSeries(series)}
            series={series.map((s) => ({ key: s.key, label: s.label }))} valueFormatter={valueFormatter}
            yDomain={yMax !== undefined ? [0, yMax] : undefined} emptyText="No samples in this time range" />
        )}
      </div>
    </Card>
  );
}
