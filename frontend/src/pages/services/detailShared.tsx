import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { checksApi, resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { JsonView, StatusBadge } from "@/components/common";
import { TimeChart, type ChartRow } from "@/components/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CheckboxField } from "@/components/ui/controls";
import type { Availability, CheckResult } from "@/types/api";
import { formatDateTime, formatDuration, formatMs, formatPercent, humanize, toDate } from "@/utils/format";
import { cn } from "@/utils/cn";

export type DetailRange = "1h" | "24h" | "7d" | "30d";
export const DETAIL_RANGES: readonly DetailRange[] = ["1h", "24h", "7d", "30d"];

function StatBox({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 shadow-xs">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <span className={cn("tabular text-lg font-semibold leading-tight",
        tone === "good" && "text-emerald-600 dark:text-emerald-400",
        tone === "warn" && "text-amber-600 dark:text-amber-400",
        tone === "bad" && "text-red-600 dark:text-red-400")}>{value}</span>
    </div>
  );
}

/** Merge resource-level availability with the check-level entry (resource aggregates leave some percentiles null). */
export function pickAvailability(resource: Availability | null | undefined, check: Availability | null | undefined): Availability | null {
  if (!resource && !check) return null;
  if (!resource) return check ?? null;
  if (!check) return resource;
  const out = { ...resource };
  (Object.keys(out) as (keyof Availability)[]).forEach((k) => {
    if (out[k] === null || out[k] === undefined) (out as Record<string, unknown>)[k] = check[k];
  });
  return out;
}

export function AvailabilityStats({ av }: { av: Availability | null }) {
  if (!av) return <p className="text-sm text-muted-foreground">No availability data for this range yet.</p>;
  const up = av.uptime_percent;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      <StatBox label="Uptime" value={formatPercent(up, 3)} tone={up === null ? undefined : up >= 99.9 ? "good" : up >= 99 ? "warn" : "bad"} />
      <StatBox label="Coverage" value={formatPercent(av.coverage_percent, 1)} />
      <StatBox label="Downtime" value={formatDuration(av.downtime_seconds)} tone={av.downtime_seconds > 0 ? "bad" : undefined} />
      <StatBox label="Avg" value={formatMs(av.avg_ms)} />
      <StatBox label="Min / Max" value={<>{formatMs(av.min_ms)} <span className="text-muted-foreground">/</span> {formatMs(av.max_ms)}</>} />
      <StatBox label="P95" value={formatMs(av.p95_ms)} />
      <StatBox label="P99" value={formatMs(av.p99_ms)} />
      <StatBox label="Down / Unknown" value={`${av.down} / ${av.unknown}`} tone={av.down > 0 ? "bad" : undefined} />
    </div>
  );
}

export function useAvailability(resourceId: string, range: string) {
  return useQuery({
    queryKey: qk.resourceAvailability(resourceId, { range }),
    queryFn: () => resourcesApi.availability(resourceId, { range }),
  });
}

export function useCheckTimeseries(checkId: string | undefined, range: string) {
  return useQuery({
    queryKey: qk.checkTimeseries(checkId ?? "", { range }),
    queryFn: () => checksApi.timeseries(checkId ?? "", { range }),
    enabled: Boolean(checkId),
  });
}

export function latencyRows(points: { bucket: string; avg_ms: number | null }[]): ChartRow[] {
  const rows: ChartRow[] = [];
  for (const p of points) {
    const t = toDate(p.bucket)?.getTime();
    if (t !== undefined) rows.push({ t, avg_ms: p.avg_ms });
  }
  return rows;
}

/** Recent check results table with failures-only toggle and expandable details. */
export function CheckResultsCard({ checkId, range, http }: { checkId: string; range: string; http?: boolean }) {
  const [failuresOnly, setFailuresOnly] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const q = useQuery({
    queryKey: qk.checkResults(checkId, { range, failuresOnly }),
    queryFn: () => checksApi.results(checkId, { range, limit: 200, status: failuresOnly ? ["down", "degraded"] : undefined }),
  });
  const rows: CheckResult[] = q.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent results</CardTitle>
        <CheckboxField id={`failures-${checkId}`} label="Failures only" checked={failuresOnly} onCheckedChange={setFailuresOnly} />
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !rows.length ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{failuresOnly ? "No failures in this range." : "No results in this range yet."}</p>
      ) : (
        <div className="max-h-[480px] overflow-y-auto">
          <Table>
            <THead>
              <TR>
                <TH>Time</TH><TH>Status</TH>{http && <TH>HTTP</TH>}<TH className="text-right">Latency</TH>
                {http && <TH className="text-right">DNS / Connect / TLS / TTFB</TH>}<TH>Message</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => {
                const key = r.scheduled_at;
                const open = expanded === key;
                return (
                  <React.Fragment key={key}>
                    <TR className="cursor-pointer" onClick={() => setExpanded(open ? null : key)} aria-expanded={open}>
                      <TD className="whitespace-nowrap text-xs">
                        <button type="button" className="hover:underline" aria-label={`Toggle details for result at ${formatDateTime(r.scheduled_at, { seconds: true })}`}>
                          {formatDateTime(r.scheduled_at, { seconds: true })}
                        </button>
                      </TD>
                      <TD><StatusBadge status={r.in_maintenance ? "maintenance" : r.status} /></TD>
                      {http && <TD className="tabular">{r.http_status ?? "—"}</TD>}
                      <TD className="tabular text-right">{formatMs(r.latency_ms)}</TD>
                      {http && (
                        <TD className="tabular whitespace-nowrap text-right text-xs text-muted-foreground">
                          {formatMs(r.dns_ms)} / {formatMs(r.connect_ms)} / {formatMs(r.tls_ms)} / {formatMs(r.ttfb_ms)}
                        </TD>
                      )}
                      <TD className="max-w-[420px] truncate text-xs" title={r.message}>{r.message}</TD>
                    </TR>
                    {open && (
                      <TR>
                        <TD colSpan={http ? 6 : 4} className="bg-muted/30">
                          <JsonView value={r.details} />
                        </TD>
                      </TR>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

/** Generic key/value rendering of a JSON object (e.g. certificate details). */
export function ObjectTable({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {Object.entries(value).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{humanize(k)}</dt>
          <dd className="min-w-0 break-words">
            {v === null || v === undefined || v === "" ? "—"
              : typeof v === "object" ? <span className="font-mono text-xs">{Array.isArray(v) ? v.map(String).join(", ") : JSON.stringify(v)}</span>
              : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? formatDateTime(v)
              : String(v)}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function LatencyCard({ checkId, range, title = "Response time" }: { checkId: string; range: string; title?: string }) {
  const ts = useCheckTimeseries(checkId, range);
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {ts.isLoading ? <LoadingState /> : ts.isError ? <ErrorState error={ts.error} onRetry={() => void ts.refetch()} /> : (
          <TimeChart ariaLabel={`${title} chart`} data={latencyRows(ts.data?.points ?? [])} series={[{ key: "avg_ms", label: "Avg response (ms)" }]}
            kind="area" valueFormatter={(v) => `${Math.round(v)} ms`} />
        )}
      </CardContent>
    </Card>
  );
}
