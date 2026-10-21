import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState } from "@/components/ui/states";
import { cn } from "@/utils/cn";
import { formatDateTime, formatTick, toDate } from "@/utils/format";
import { SERIES_COLORS } from "@/utils/status";

export interface SeriesDef {
  key: string;
  label: string;
  color?: string;
}

export type ChartRow = { t: number } & Record<string, number | null>;

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 12,
  color: "var(--popover-foreground)",
  padding: "6px 8px",
};

function rangeOf(rows: ChartRow[]): number {
  if (rows.length < 2) return 3600;
  return (rows[rows.length - 1].t - rows[0].t) / 1000;
}

/** Merge several [ts,value] series into chart rows keyed by timestamp. */
export function mergeSeries(series: { key: string; points: [string, number][] }[]): ChartRow[] {
  const map = new Map<number, ChartRow>();
  for (const s of series) {
    for (const [ts, v] of s.points) {
      const t = toDate(ts)?.getTime();
      if (t === undefined) continue;
      const row = map.get(t) ?? ({ t } as ChartRow);
      row[s.key] = v;
      map.set(t, row);
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

interface TimeChartProps {
  data: ChartRow[];
  series: SeriesDef[];
  height?: number;
  valueFormatter?: (v: number) => string;
  yDomain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
  kind?: "line" | "area" | "stacked-bar";
  emptyText?: string;
  showLegend?: boolean;
  className?: string;
  ariaLabel: string;
}

/** Time-series chart (line / area / stacked bars) with theme-aware styling. */
export function TimeChart({ data, series, height = 220, valueFormatter = (v) => String(Math.round(v * 100) / 100),
  yDomain, kind = "line", emptyText = "No data in this time range", showLegend, className, ariaLabel }: TimeChartProps) {
  if (!data.length) {
    return <div style={{ height }} className="flex items-center justify-center"><EmptyState title={emptyText} className="py-4" /></div>;
  }
  const range = rangeOf(data);
  const legend = showLegend ?? series.length > 1;
  const common = {
    data,
    margin: { top: 6, right: 8, bottom: 0, left: 0 },
  };
  const xAxis = (
    <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false}
      tickFormatter={(v: number) => formatTick(v, range)} minTickGap={40} />
  );
  const yAxis = (
    <YAxis width={52} tickLine={false} axisLine={false} domain={yDomain ?? [0, "auto"]}
      tickFormatter={(v: number) => valueFormatter(v)} />
  );
  const tooltip = (
    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(v: number) => formatDateTime(v, { seconds: true })}
      formatter={(v: number, name: string) => [valueFormatter(Number(v)), name]} />
  );
  const color = (i: number, s: SeriesDef) => s.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
  return (
    <div role="img" aria-label={ariaLabel} className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {kind === "stacked-bar" ? (
          <BarChart {...common}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            {xAxis}
            {yAxis}
            {tooltip}
            {legend && <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={color(i, s)} isAnimationActive={false} />)}
          </BarChart>
        ) : kind === "area" ? (
          <AreaChart {...common}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            {xAxis}
            {yAxis}
            {tooltip}
            {legend && <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Area key={s.key} dataKey={s.key} name={s.label} type="monotone" stroke={color(i, s)} fill={color(i, s)}
                fillOpacity={0.15} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
            ))}
          </AreaChart>
        ) : (
          <LineChart {...common}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            {xAxis}
            {yAxis}
            {tooltip}
            {legend && <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Line key={s.key} dataKey={s.key} name={s.label} type="monotone" stroke={color(i, s)} strokeWidth={1.5}
                dot={false} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal availability strip: one cell per bucket colored by its outcome mix. */
export function AvailabilityStrip({ buckets, ariaLabel }: {
  buckets: { bucket: string; up: number; degraded: number; down: number; unknown: number; maintenance: number }[];
  ariaLabel: string;
}) {
  if (!buckets.length) return <p className="py-3 text-center text-xs text-muted-foreground">No check results in this range</p>;
  return (
    <div role="img" aria-label={ariaLabel} className="flex h-7 w-full items-stretch gap-px overflow-hidden rounded">
      {buckets.map((b) => {
        const known = b.up + b.degraded + b.down;
        const color = b.down > 0 ? (b.down >= known / 2 ? "#ef4444" : "#f59e0b")
          : b.degraded > 0 ? "#f59e0b" : b.up > 0 ? "#10b981" : b.maintenance > 0 ? "#0ea5e9" : "#94a3b8";
        const pct = known ? (((b.up + b.degraded) / known) * 100).toFixed(1) : "n/a";
        return (
          <div key={b.bucket} className="min-w-[2px] flex-1" style={{ background: color }}
            title={`${formatDateTime(b.bucket)} — uptime ${pct}% (up ${b.up}, degraded ${b.degraded}, down ${b.down}, unknown ${b.unknown})`} />
        );
      })}
    </div>
  );
}

/** Simple horizontal bar for values (e.g. utilization rows). */
export function MeterCell({ value, warn = 80, crit = 90, suffix = "%" }: { value: number | null | undefined; warn?: number; crit?: number; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  const color = value >= crit ? "#ef4444" : value >= warn ? "#f59e0b" : "#10b981";
  return (
    <div className="flex min-w-[90px] items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }} />
      </div>
      <span className="tabular w-12 text-right text-xs">{value.toFixed(1)}{suffix}</span>
    </div>
  );
}
