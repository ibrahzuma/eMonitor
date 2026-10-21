import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Bookmark, ChevronDown, ChevronRight, Download, Radio, Save, Search, Trash2, X } from "lucide-react";
import * as React from "react";
import { errorMessage, type Query } from "@/api/client";
import { logsApi, savedSearchesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { type ChartRow, TimeChart } from "@/components/charts";
import { DefinitionList, JsonView, PageHeader, TagInput } from "@/components/common";
import { MultiSelect } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField, Segmented } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "@/components/ui/menus";
import { EmptyState, ErrorState, LoadingState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/features/auth/AuthProvider";
import { useRealtime } from "@/features/realtime/RealtimeProvider";
import { useApiMutation, useUrlFilters } from "@/hooks/useApi";
import { ENVIRONMENTS, type JsonObject, LOG_SEVERITIES, type LogFacetField, type LogRow, type SavedSearch } from "@/types/api";
import { cn } from "@/utils/cn";
import { formatDateTime, formatNumber, humanize, isoToLocalInput, localInputToIso, rangeToSeconds, toDate } from "@/utils/format";
import { LOG_SEVERITY_COLORS } from "@/utils/status";

const KEYS = ["q", "severity", "host", "application", "service", "source", "environment", "trace_id", "attr", "resource_id",
  "range", "start", "end"] as const;
type Key = (typeof KEYS)[number];
const ARRAY_KEYS: Key[] = ["severity", "host", "application", "service", "source", "attr", "resource_id"];
const RANGES = ["15m", "1h", "6h", "24h", "7d"] as const;
const FACETS: LogFacetField[] = ["severity", "host", "application", "service", "source", "environment"];
const LIVE_CAP = 1000;

function LogRowItem({ row, expanded, onToggle, onTrace, onAddFilter }: {
  row: LogRow;
  expanded: boolean;
  onToggle: () => void;
  onTrace: (t: string) => void;
  onAddFilter: (field: Key, value: string) => void;
}) {
  const color = LOG_SEVERITY_COLORS[row.severity] ?? "#64748b";
  const attrs = Object.entries(row.attributes ?? {});
  return (
    <li className="border-b last:border-0">
      <button type="button" onClick={onToggle} aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
        {expanded ? <ChevronDown className="mt-0.5 size-3 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="w-[150px] shrink-0 text-muted-foreground">{formatDateTime(row.ts, { seconds: true })}</span>
        <span className="w-16 shrink-0 font-semibold uppercase" style={{ color }}>{row.severity}</span>
        <span className="hidden w-32 shrink-0 truncate text-muted-foreground md:inline">{row.host}</span>
        <span className="hidden w-28 shrink-0 truncate text-muted-foreground lg:inline">{row.application || row.service || row.source}</span>
        <span className={cn("min-w-0 flex-1", expanded ? "whitespace-pre-wrap break-all" : "truncate")}>{row.message}</span>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 gap-3 bg-muted/30 px-8 py-3 lg:grid-cols-2">
          <DefinitionList items={[
            ["Timestamp", formatDateTime(row.ts, { seconds: true })],
            ["Severity", row.severity],
            ...(["host", "application", "service", "source", "environment"] as const).map((k): [React.ReactNode, React.ReactNode] => [
              humanize(k),
              row[k] ? <button key={k} type="button" className="text-primary hover:underline" onClick={() => onAddFilter(k, row[k])}>{row[k]}</button> : "",
            ]),
            ["Trace ID", row.trace_id ? <button key="t" type="button" className="font-mono text-xs text-primary hover:underline" onClick={() => onTrace(row.trace_id)}>{row.trace_id}</button> : ""],
            ["Resource", row.resource_id && !/^0{8}-/.test(row.resource_id) ? <span key="r" className="font-mono text-xs">{row.resource_id}</span> : ""],
            ...attrs.map(([k, v]): [React.ReactNode, React.ReactNode] => [
              <span key={k} className="font-mono text-xs">@{k}</span>,
              <button key={`${k}v`} type="button" className="break-all text-left text-primary hover:underline" onClick={() => onAddFilter("attr", `${k}=${v}`)}>{v}</button>,
            ]),
          ]} />
          <JsonView value={row} />
        </div>
      )}
    </li>
  );
}

function SaveSearchDialog({ open, onOpenChange, query }: { open: boolean; onOpenChange: (o: boolean) => void; query: JsonObject }) {
  const [name, setName] = React.useState("");
  const [shared, setShared] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setName("");
      setShared(false);
      setError(null);
    }
  }, [open]);
  const save = useApiMutation({
    mutationFn: () => savedSearchesApi.create({ name: name.trim(), kind: "logs", query, shared }),
    invalidate: [qk.savedSearches("logs")],
    success: "Search saved",
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Save search</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            setError("Name is required");
            return;
          }
          save.mutate();
        }}>
          <DialogBody className="flex flex-col gap-3">
            <Field label="Name" htmlFor="ss-name" error={error} required>
              <Input id="ss-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <CheckboxField id="ss-shared" label="Share with the organization" checked={shared} onCheckedChange={setShared} />
            <JsonView value={query} className="max-h-40" />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LogsPage() {
  const toast = useToast();
  const { user } = useAuth();
  const realtime = useRealtime();
  const { values, get, set } = useUrlFilters(KEYS);

  const range = get("range") || "1h";
  const custom = Boolean(get("start") || get("end"));
  const filters = React.useMemo(() => {
    const out: Query = {};
    for (const k of KEYS) {
      if (k === "range") continue;
      if (ARRAY_KEYS.includes(k)) {
        if (values[k].length) out[k] = values[k];
      } else if (values[k][0]) {
        out[k] = values[k][0];
      }
    }
    if (!custom) out.range = range;
    return out;
  }, [values, custom, range]);

  // search box drafts applied on submit
  const [qDraft, setQDraft] = React.useState(get("q"));
  const [traceDraft, setTraceDraft] = React.useState(get("trace_id"));
  React.useEffect(() => setQDraft(get("q")), [get]);
  React.useEffect(() => setTraceDraft(get("trace_id")), [get]);

  const search = useInfiniteQuery({
    queryKey: qk.logSearch(filters),
    queryFn: ({ pageParam }) => logsApi.search({ ...filters, limit: 100, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    placeholderData: keepPreviousData,
  });
  const histogram = useQuery({ queryKey: qk.logHistogram(filters), queryFn: () => logsApi.histogram(filters), placeholderData: keepPreviousData });
  const facets = useQueries({
    queries: FACETS.map((f) => ({ queryKey: qk.logFacets(f, filters), queryFn: () => logsApi.facets(f, filters) })),
  });
  const saved = useQuery({ queryKey: qk.savedSearches("logs"), queryFn: () => savedSearchesApi.list("logs") });
  const deleteSaved = useApiMutation({
    mutationFn: (id: string) => savedSearchesApi.remove(id),
    invalidate: [qk.savedSearches("logs")],
    success: "Saved search deleted",
  });

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  // ---------------------------------------------------------------- live tail
  const [live, setLive] = React.useState(false);
  const [liveRows, setLiveRows] = React.useState<LogRow[]>([]);
  const connected = realtime.status === "connected";
  React.useEffect(() => {
    if (!connected && live) setLive(false);
  }, [connected, live]);
  const liveFilter = React.useMemo(() => {
    const f: Record<string, string> = {};
    if (values.severity[0]) f.severity = values.severity[0];
    if (values.application[0]) f.application = values.application[0];
    if (values.host[0]) f.host = values.host[0];
    if (values.q[0]) f.q = values.q[0];
    return f;
  }, [values]);
  React.useEffect(() => {
    if (!live) return;
    const unsub = realtime.subscribe((msg) => {
      if (msg.type !== "log_tail" || !Array.isArray(msg.data)) return;
      const rows = (msg.data as LogRow[]).slice().reverse();
      setLiveRows((prev) => [...rows, ...prev].slice(0, LIVE_CAP));
    });
    realtime.send({ type: "subscribe_logs", ...liveFilter });
    return () => {
      unsub();
      realtime.send({ type: "unsubscribe_logs" });
    };
  }, [live, liveFilter, realtime]);

  // ---------------------------------------------------------------- helpers
  const toggleArray = (k: Key, v: string) => {
    const cur = values[k];
    set({ [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const addFilter = (k: Key, v: string) => {
    if (ARRAY_KEYS.includes(k)) {
      if (!values[k].includes(v)) set({ [k]: [...values[k], v] });
    } else {
      set({ [k]: v });
    }
  };
  const setTrace = (t: string) => set({ trace_id: t });

  const currentQuery = (): JsonObject => {
    const o: JsonObject = {};
    for (const k of KEYS) {
      if (ARRAY_KEYS.includes(k)) {
        if (values[k].length) o[k] = values[k];
      } else if (values[k][0]) {
        o[k] = values[k][0];
      }
    }
    return o;
  };
  const applySaved = (s: SavedSearch) => {
    const patch: Partial<Record<Key, string | string[] | null>> = {};
    for (const k of KEYS) {
      const v = s.query[k];
      patch[k] = Array.isArray(v) ? v.map(String) : v === undefined || v === null ? null : String(v);
    }
    set(patch);
    toast.info(`Applied “${s.name}”`);
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const name = await logsApi.export({ ...filters, limit: 50000 });
      toast.success("Export downloaded", name);
    } catch (e) {
      toast.error("Export failed", errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  // ---------------------------------------------------------------- histogram data
  const histRows = React.useMemo<ChartRow[]>(() => {
    const map = new Map<number, ChartRow>();
    for (const p of histogram.data?.points ?? []) {
      const t = toDate(p.bucket)?.getTime();
      if (t === undefined) continue;
      const row = map.get(t) ?? ({ t } as ChartRow);
      row[p.severity] = ((row[p.severity] as number | null | undefined) ?? 0) + p.count;
      map.set(t, row);
    }
    return [...map.values()].sort((a, b) => a.t - b.t);
  }, [histogram.data]);
  const histSeverities = LOG_SEVERITIES.filter((s) => histRows.some((r) => r[s] !== undefined));
  const totalInHistogram = (histogram.data?.points ?? []).reduce((a, p) => a + p.count, 0);

  const rows = live ? liveRows : (search.data?.pages.flatMap((p) => p.items) ?? []);
  const activeChips: [Key, string][] = [];
  for (const k of KEYS) {
    if (k === "range" || k === "start" || k === "end" || k === "q") continue;
    for (const v of values[k]) activeChips.push([k, v]);
  }

  return (
    <div>
      <PageHeader
        title="Logs"
        description={histogram.data ? `${formatNumber(totalInHistogram)} matching events in range` : "Search, filter and tail logs"}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline"><Bookmark /> Saved searches</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Saved log searches</DropdownMenuLabel>
                {saved.isLoading && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>}
                {saved.data && !saved.data.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No saved searches yet.</p>}
                {saved.data?.map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => applySaved(s)}>
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {s.shared && <Badge variant="outline">shared</Badge>}
                    {s.user_id === user?.id && (
                      <button type="button" aria-label={`Delete saved search ${s.name}`} className="rounded p-0.5 hover:bg-destructive/10"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteSaved.mutate(s.id); }}>
                        <Trash2 className="size-3.5 text-destructive" />
                      </button>
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setSaveOpen(true)}><Save /> Save current search…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" onClick={() => void doExport()} loading={exporting}><Download /> Export CSV</Button>
            <Tooltip content={connected ? "Stream new matching logs in real time" : "Live tail needs the live event connection (unavailable — the server may lack Redis)"}>
              <span>
                <Button variant={live ? "default" : "outline"} disabled={!connected} aria-pressed={live}
                  onClick={() => { setLiveRows([]); setLive((l) => !l); }}>
                  <Radio className={cn(live && "animate-pulse")} /> {live ? "Stop live tail" : "Live tail"}
                </Button>
              </span>
            </Tooltip>
          </>
        }
      />

      <Card className="mb-3">
        <form className="flex flex-col gap-2 p-3 lg:flex-row lg:items-end" onSubmit={(e) => {
          e.preventDefault();
          set({ q: qDraft.trim() || null, trace_id: traceDraft.trim() || null });
        }}>
          <Field label="Query" htmlFor="logs-q" className="flex-1" hint='Words must all match; use "quotes" for phrases'>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="logs-q" type="search" className="pl-8 font-mono" value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder='timeout "connection refused"' />
            </div>
          </Field>
          <Field label="Trace ID" htmlFor="logs-trace" className="lg:w-64">
            <Input id="logs-trace" className="font-mono" value={traceDraft} onChange={(e) => setTraceDraft(e.target.value)} />
          </Field>
          <Button type="submit"><Search /> Search</Button>
        </form>
        <div className="grid grid-cols-1 gap-2 border-t p-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="logs-sev" className="text-xs font-medium">Severity</label>
            <MultiSelect id="logs-sev" ariaLabel="Severity filter" value={values.severity} onChange={(v) => set({ severity: v })}
              options={LOG_SEVERITIES.map((s) => ({ value: s, label: s }))} placeholder="Any severity" />
          </div>
          <Field label="Environment" htmlFor="logs-env">
            <NativeSelect id="logs-env" value={get("environment")} onChange={(e) => set({ environment: e.target.value || null })}>
              <option value="">Any environment</option>
              {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Attributes (key=value)" htmlFor="logs-attr" className="xl:col-span-2">
            <TagInput id="logs-attr" value={values.attr} placeholder="user_id=42, then Enter"
              onChange={(v) => {
                const bad = v.find((x) => !x.includes("="));
                if (bad) toast.error("Attribute filters must look like key=value", bad);
                set({ attr: v.filter((x) => x.includes("=")) });
              }} />
          </Field>
          {(["host", "application", "service", "source"] as const).map((k) => (
            <Field key={k} label={humanize(k)} htmlFor={`logs-${k}`}>
              <TagInput id={`logs-${k}`} value={values[k]} onChange={(v) => set({ [k]: v })} placeholder={`Any ${k}`} />
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <Segmented label="Time range" value={custom ? "custom" : range} onChange={(v) => {
            if (v === "custom") {
              const end = new Date();
              const start = new Date(end.getTime() - rangeToSeconds(range) * 1000);
              set({ start: start.toISOString(), end: end.toISOString(), range: null });
            } else {
              set({ range: v, start: null, end: null });
            }
          }} options={[...RANGES, { value: "custom", label: "Custom" }]} />
          {custom && (
            <>
              <label className="sr-only" htmlFor="logs-start">Start</label>
              <Input id="logs-start" type="datetime-local" className="w-48" value={isoToLocalInput(get("start"))}
                onChange={(e) => set({ start: localInputToIso(e.target.value) })} />
              <span className="text-xs text-muted-foreground">to</span>
              <label className="sr-only" htmlFor="logs-end">End</label>
              <Input id="logs-end" type="datetime-local" className="w-48" value={isoToLocalInput(get("end"))}
                onChange={(e) => set({ end: localInputToIso(e.target.value) })} />
            </>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {activeChips.map(([k, v]) => (
              <Badge key={`${k}:${v}`} variant="default" className="gap-0.5 pr-0.5">
                <span className="text-[10px] opacity-70">{k}:</span>{k === "resource_id" ? v.slice(0, 8) : v}
                <button type="button" aria-label={`Remove filter ${k} ${v}`} className="rounded p-0.5 hover:bg-primary/20"
                  onClick={() => (ARRAY_KEYS.includes(k) ? toggleArray(k, v) : set({ [k]: null }))}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            {(activeChips.length > 0 || get("q")) && (
              <Button variant="ghost" size="sm" onClick={() => {
                setQDraft("");
                setTraceDraft("");
                set(Object.fromEntries(KEYS.filter((k) => k !== "range" && k !== "start" && k !== "end").map((k) => [k, null])));
              }}>Clear all</Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="mb-3">
        <CardHeader>
          <CardTitle>Volume by severity</CardTitle>
          {histogram.isFetching && <Spinner />}
        </CardHeader>
        <CardContent className="py-2">
          {histogram.isError ? <ErrorState error={histogram.error} onRetry={() => void histogram.refetch()} /> : histogram.isLoading ? <LoadingState /> : (
            <TimeChart ariaLabel="Log volume histogram by severity" data={histRows} kind="stacked-bar" height={140}
              series={histSeverities.map((s) => ({ key: s, label: s, color: LOG_SEVERITY_COLORS[s] }))} valueFormatter={(v) => formatNumber(v)}
              emptyText="No logs in this time range" />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr]">
        <Card className="h-fit">
          <CardHeader><CardTitle>Facets</CardTitle></CardHeader>
          <div className="flex flex-col divide-y">
            {FACETS.map((f, i) => {
              const fq = facets[i];
              const key = f as Key;
              return (
                <div key={f} className="px-3 py-2">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{humanize(f)}</p>
                  {fq.isLoading ? <Spinner /> : fq.isError ? <p className="text-xs text-destructive">Failed to load</p> : !fq.data?.length ? (
                    <p className="text-xs text-muted-foreground">No values</p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {fq.data.slice(0, 10).map((v) => {
                        const active = values[key].includes(v.value);
                        const label = v.value || "(empty)";
                        return (
                          <li key={v.value}>
                            <button type="button" aria-pressed={active} disabled={!v.value}
                              onClick={() => (ARRAY_KEYS.includes(key) ? toggleArray(key, v.value) : set({ [key]: active ? null : v.value }))}
                              className={cn("flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent disabled:opacity-60",
                                active && "bg-primary/10 font-medium text-primary")}>
                              {f === "severity" && <span className="size-2 shrink-0 rounded-full" style={{ background: LOG_SEVERITY_COLORS[v.value] }} aria-hidden />}
                              <span className="min-w-0 flex-1 truncate">{label}</span>
                              <span className="tabular text-muted-foreground">{formatNumber(v.count)}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{live ? `Live tail (${liveRows.length})` : "Events"}</CardTitle>
            {live && <span className="flex items-center gap-1.5 text-xs text-emerald-600"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> streaming</span>}
            {!live && search.isFetching && !search.isFetchingNextPage && <Spinner />}
          </CardHeader>
          {!live && search.isLoading ? <LoadingState /> : !live && search.isError ? (
            <ErrorState error={search.error} onRetry={() => void search.refetch()} />
          ) : !rows.length ? (
            <EmptyState title={live ? "Waiting for new log events…" : "No logs match"}
              description={live ? "New events matching the severity/application/host/query filters will appear here." : "Adjust the query, filters or time range."} />
          ) : (
            <>
              <ul aria-label="Log events">
                {rows.map((r) => (
                  <LogRowItem key={r.id} row={r} expanded={expanded.has(r.id)} onTrace={setTrace} onAddFilter={addFilter}
                    onToggle={() => setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    })} />
                ))}
              </ul>
              {!live && (
                <div className="flex justify-center border-t p-2">
                  {search.hasNextPage ? (
                    <Button variant="outline" size="sm" loading={search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>Load more</Button>
                  ) : <span className="text-xs text-muted-foreground">End of results ({rows.length} shown)</span>}
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      <SaveSearchDialog open={saveOpen} onOpenChange={setSaveOpen} query={currentQuery()} />
    </div>
  );
}
