import { Search } from "lucide-react";
import * as React from "react";
import { TagInput } from "@/components/common";
import { Input, NativeSelect } from "@/components/ui/input";
import { useDebounced } from "@/hooks/useApi";
import { ENVIRONMENTS, HEALTH_STATUSES } from "@/types/api";
import { humanize } from "@/utils/format";

export interface ListFilterState {
  q: string;
  status: string;
  environment: string;
  tags: string[];
}

/** Filter bar shared by the resource list pages; values live in the URL (useUrlFilters). */
export function ResourceFilterBar({ get, values, set, showEnvironment = true, extra }: {
  get: (k: "q" | "status" | "environment" | "page") => string;
  values: { tag: string[] };
  set: (patch: Partial<Record<"q" | "status" | "environment" | "tag" | "page", string | string[] | null>>) => void;
  showEnvironment?: boolean;
  extra?: React.ReactNode;
}) {
  const [q, setQ] = React.useState(get("q"));
  const dq = useDebounced(q, 300);
  const current = get("q");
  React.useEffect(() => {
    if (dq !== current) set({ q: dq || null });
  }, [dq, current, set]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input aria-label="Search" placeholder="Search name or address…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
      </div>
      <NativeSelect aria-label="Status filter" value={get("status")} onChange={(e) => set({ status: e.target.value || null })} className="w-36">
        <option value="">All statuses</option>
        {HEALTH_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
      </NativeSelect>
      {showEnvironment && (
        <NativeSelect aria-label="Environment filter" value={get("environment")} onChange={(e) => set({ environment: e.target.value || null })} className="w-40">
          <option value="">All environments</option>
          {ENVIRONMENTS.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </NativeSelect>
      )}
      <div className="min-w-[180px] sm:w-56">
        <TagInput ariaLabel="Tag filter" value={values.tag} onChange={(v) => set({ tag: v })} placeholder="Filter by tag…" />
      </div>
      {extra}
    </div>
  );
}

export function sslDaysOf(details: unknown): number | null {
  if (!details || typeof details !== "object") return null;
  const cert = (details as Record<string, unknown>).certificate;
  if (!cert || typeof cert !== "object") return null;
  const d = (cert as Record<string, unknown>).days_remaining;
  return typeof d === "number" ? d : null;
}

export function SslDays({ days }: { days: number | null }) {
  if (days === null) return <span className="text-muted-foreground">—</span>;
  const cls = days < 7 ? "text-red-600 dark:text-red-400 font-semibold" : days < 14 ? "text-amber-600 dark:text-amber-400 font-medium" : "";
  return <span className={`tabular ${cls}`}>{days}d</span>;
}

export function UptimeCell({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  const cls = value < 99 ? "text-red-600 dark:text-red-400" : value < 99.9 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";
  return <span className={`tabular ${cls}`}>{value.toFixed(2)}%</span>;
}
