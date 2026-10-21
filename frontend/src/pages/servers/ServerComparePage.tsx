import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { metricsApi, resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader } from "@/components/common";
import { ResourcePicker } from "@/components/pickers";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { Field, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { formatNumber } from "@/utils/format";
import { MetricChart } from "@/pages/servers/MetricChart";

const RANGES = ["15m", "1h", "6h", "24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

export function ServerComparePage() {
  const [params, setParams] = useSearchParams();
  const ids = params.getAll("id");
  const metric = params.get("metric") || "cpu_percent";
  const range = (RANGES as readonly string[]).includes(params.get("range") ?? "") ? (params.get("range") as Range) : "1h";
  const update = (patch: { id?: string[]; metric?: string; range?: string }) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (patch.id) { n.delete("id"); patch.id.forEach((x) => n.append("id", x)); }
      if (patch.metric) n.set("metric", patch.metric);
      if (patch.range) n.set("range", patch.range);
      return n;
    }, { replace: true });
  };

  const servers = useQuery({ queryKey: qk.resourceList("compare", { kind: ["server"] }), queryFn: () => resourcesApi.list({ kind: ["server"], page_size: 500 }) });
  const names = Object.fromEntries((servers.data?.items ?? []).map((r) => [r.id, r.name]));
  const nameQueries = useQueries({
    queries: ids.map((id) => ({ queryKey: qk.metricNames(id), queryFn: () => metricsApi.names(id) })),
  });
  const metrics = Array.from(new Set(["cpu_percent", ...nameQueries.flatMap((q) => (q.data ?? []).map((n) => n.metric))])).sort();
  const isPct = metric.endsWith("_percent");

  return (
    <div className="flex flex-col gap-4">
      <Link to="/servers" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> Servers
      </Link>
      <PageHeader title="Compare servers" description="Overlay one metric across several servers." />
      <Card className="grid grid-cols-1 gap-3 p-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
        <Field label="Servers" htmlFor="cmp-servers">
          <ResourcePicker id="cmp-servers" kinds={["server"]} value={ids} onChange={(v) => update({ id: v.slice(0, 20) })} />
        </Field>
        <Field label="Metric" htmlFor="cmp-metric">
          <NativeSelect id="cmp-metric" value={metric} onChange={(e) => update({ metric: e.target.value })}>
            {metrics.map((m) => <option key={m} value={m}>{m}</option>)}
          </NativeSelect>
        </Field>
        <Segmented label="Range" value={range} options={RANGES} onChange={(v) => update({ range: v })} />
      </Card>
      {ids.length === 0 ? (
        <Card><EmptyState title="Select servers to compare" description="Pick two or more servers above, or select them on the Servers list." /></Card>
      ) : (
        <MetricChart title={`${metric} (${range})`} resourceIds={ids} metrics={[{ metric }]} range={range} resourceNames={names}
          height={340} valueFormatter={(v) => (isPct ? `${v.toFixed(0)}%` : formatNumber(v, 2))} yMax={isPct ? 100 : undefined} />
      )}
    </div>
  );
}

