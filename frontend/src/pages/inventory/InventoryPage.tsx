import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileUp, Search } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { CodeBlock, PageHeader, Pagination, RelativeTime, StatusBadge, StatusDot, TagInput } from "@/components/common";
import { GroupSelect } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useApiMutation, useDebounced, useUrlFilters } from "@/hooks/useApi";
import { ENVIRONMENTS, HEALTH_STATUSES, type ImportResult, type JsonObject, RESOURCE_KINDS } from "@/types/api";
import { humanize } from "@/utils/format";
import { KIND_LABELS, resourcePath, statusStyle } from "@/utils/status";
import { layoutDependencyMap } from "@/pages/inventory/dependencyLayout";
import { parseImport } from "@/pages/inventory/importParse";

const PAGE_SIZE = 50;
const KEYS = ["kind", "status", "environment", "group_id", "tag", "q", "page", "tab"] as const;

function ResourcesTab() {
  const { values, get, set } = useUrlFilters(KEYS);
  const [search, setSearch] = React.useState(get("q"));
  const dq = useDebounced(search, 300);
  React.useEffect(() => {
    if (dq !== get("q")) set({ q: dq || null });
  }, [dq, get, set]);
  const page = Math.max(1, Number(get("page")) || 1);
  const query = {
    kind: values.kind, status: values.status, environment: get("environment"), group_id: get("group_id"), tag: values.tag,
    q: get("q"), page, page_size: PAGE_SIZE,
  };
  const list = useQuery({ queryKey: qk.resourceList("inventory", query), queryFn: () => resourcesApi.list(query) });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search resources" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
        <NativeSelect aria-label="Kind filter" className="w-40" value={values.kind[0] ?? ""} onChange={(e) => set({ kind: e.target.value ? [e.target.value] : null })}>
          <option value="">All kinds</option>
          {RESOURCE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </NativeSelect>
        <NativeSelect aria-label="Status filter" className="w-36" value={values.status[0] ?? ""} onChange={(e) => set({ status: e.target.value ? [e.target.value] : null })}>
          <option value="">All statuses</option>
          {HEALTH_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </NativeSelect>
        <NativeSelect aria-label="Environment filter" className="w-36" value={get("environment")} onChange={(e) => set({ environment: e.target.value || null })}>
          <option value="">All environments</option>
          {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
        </NativeSelect>
        <div className="w-40"><GroupSelect value={get("group_id")} onChange={(v) => set({ group_id: v || null })} emptyLabel="All groups" /></div>
        <div className="w-48"><TagInput ariaLabel="Tag filter" value={values.tag} onChange={(v) => set({ tag: v })} placeholder="Filter tags…" /></div>
      </div>
      {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> :
        !list.data?.items.length ? <EmptyState title="No resources match" description="Adjust the filters or import resources in bulk." /> : (
          <>
            <Table>
              <THead><TR><TH>Name</TH><TH>Kind</TH><TH>Status</TH><TH>Environment</TH><TH>Address</TH><TH>Checks</TH><TH>Tags</TH><TH>Status changed</TH></TR></THead>
              <TBody>
                {list.data.items.map((r) => (
                  <TR key={r.id}>
                    <TD><Link to={resourcePath(r.kind, r.id)} className="font-medium hover:underline">{r.name}</Link></TD>
                    <TD>{KIND_LABELS[r.kind] ?? r.kind}</TD>
                    <TD><StatusBadge status={r.is_paused ? "maintenance" : r.status} /></TD>
                    <TD>{r.environment}</TD>
                    <TD className="max-w-[260px] truncate font-mono text-xs" title={r.address}>{r.address || "—"}</TD>
                    <TD className="tabular">{r.checks?.length ?? 0}</TD>
                    <TD><div className="flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}</div></TD>
                    <TD className="text-xs"><RelativeTime value={r.status_changed_at} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
    </Card>
  );
}

const SAMPLE_CSV = `name,kind,address,environment,location,business_owner,description,tags
db-primary,database,10.0.1.10,production,eu-west-1,Data team,Primary PostgreSQL,db;critical
web-02,server,10.0.2.12,staging,,,Staging web node,web`;

function ImportTab() {
  const canWrite = useCan("resources:write");
  const [text, setText] = React.useState("");
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<JsonObject[]>([]);
  const [dry, setDry] = React.useState<ImportResult | null>(null);
  const [done, setDone] = React.useState<ImportResult | null>(null);

  const run = useApiMutation({
    mutationFn: ({ list, dryRun }: { list: JsonObject[]; dryRun: boolean }) => resourcesApi.import(list, dryRun),
    errorTitle: "Import failed",
    invalidate: [qk.resources, qk.dashboard],
    success: (r, v) => (v.dryRun ? null : `Imported ${r.created} resource(s)`),
    onSuccess: (r, v) => (v.dryRun ? setDry(r) : setDone(r)),
  });

  const validate = () => {
    setDone(null);
    setDry(null);
    const res = parseImport(text);
    setParseError(res.error);
    setItems(res.items);
    if (!res.error) run.mutate({ list: res.items, dryRun: true });
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    setDry(null);
    setDone(null);
  };

  if (!canWrite) return <Card><EmptyState title="You don't have permission to import resources" /></Card>;
  const result = done ?? dry;
  const valid = dry ? items.length - dry.errors.length : 0;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader>
          <CardTitle>Bulk import</CardTitle>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent">
            <FileUp className="size-3.5" aria-hidden /> Load file
            <input type="file" accept=".csv,.json,text/csv,application/json" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label htmlFor="import-text" className="text-xs font-medium">Paste CSV (with header row) or a JSON array</label>
          <Textarea id="import-text" rows={12} className="font-mono text-xs" value={text} placeholder={SAMPLE_CSV}
            onChange={(e) => { setText(e.target.value); setDry(null); setDone(null); }} />
          {parseError && <InlineError error={new Error(parseError)} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={validate} loading={run.isPending && run.variables?.dryRun}>Validate (dry run)</Button>
            <Button onClick={() => run.mutate({ list: items, dryRun: false })} disabled={!dry || valid <= 0 || Boolean(done)}
              loading={run.isPending && run.variables?.dryRun === false}>
              Import {dry ? `${valid} valid row(s)` : ""}
            </Button>
          </div>
          {result && (
            <div className="flex flex-col gap-2">
              {done ? (
                <p role="status" className="flex items-center gap-1.5 text-sm"><CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
                  Created {done.created} resource(s){done.errors.length ? `, ${done.errors.length} row(s) failed` : ""}.</p>
              ) : (
                <p role="status" className="text-sm">Dry run: {items.length} row(s), {valid} valid, {dry?.errors.length ?? 0} with errors. Nothing was created.</p>
              )}
              {result.errors.length > 0 && (
                <Table>
                  <THead><TR><TH>Row</TH><TH>Name</TH><TH>Errors</TH></TR></THead>
                  <TBody>
                    {result.errors.map((e) => (
                      <TR key={e.index}>
                        <TD className="tabular">{e.index + 1}</TD>
                        <TD>{String(items[e.index]?.name ?? "—")}</TD>
                        <TD>
                          <ul className="text-xs text-destructive">
                            {e.errors.map((x, i) => <li key={i}>{x.loc?.length ? `${x.loc.join(".")}: ` : ""}{x.msg}</li>)}
                          </ul>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Format</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">CSV columns: <code className="text-xs">name, kind, address, environment, location, business_owner, description, tags</code>.
            Tags are separated by semicolons. Kind is one of {RESOURCE_KINDS.join(", ")}.</p>
          <CodeBlock code={SAMPLE_CSV} />
          <p className="text-muted-foreground">JSON items accept every resource field, including <code className="text-xs">checks</code>:</p>
          <CodeBlock code={`[{"name": "api-gw", "kind": "api", "address": "https://api.example.com",
  "checks": [{"name": "HTTP", "type": "http", "config": {"url": "https://api.example.com/health"}}]}]`} />
        </CardContent>
      </Card>
    </div>
  );
}

const NODE_W = 170;
const NODE_H = 34;
const COL_GAP = 70;
const ROW_GAP = 16;

function DependencyMapTab() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: qk.dependencyMap, queryFn: resourcesApi.dependencyMap });
  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const map = q.data;
  if (!map || !map.nodes.length) {
    return (
      <Card>
        <EmptyState title="No dependencies defined"
          description="Open a resource, go to its Settings tab and add “depends on” relationships (e.g. web app → database). They appear here as a map." />
      </Card>
    );
  }
  const { layers } = layoutDependencyMap(map);
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((ids, li) => ids.forEach((id, i) => pos.set(id, { x: 10 + li * (NODE_W + COL_GAP), y: 10 + i * (NODE_H + ROW_GAP) })));
  const width = 20 + layers.length * (NODE_W + COL_GAP) - COL_GAP;
  const height = 20 + Math.max(...layers.map((l) => l.length)) * (NODE_H + ROW_GAP) - ROW_GAP;
  const nodes = new Map(map.nodes.map((n) => [n.id, n] as const));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Dependency map</CardTitle>
          <span className="text-xs text-muted-foreground">Arrows point from a resource to what it depends on · foundations on the left</span>
        </CardHeader>
        <div className="overflow-auto p-3">
          <svg width={width} height={height} role="img" aria-label="Resource dependency map" className="text-foreground">
            <defs>
              <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.5" />
              </marker>
            </defs>
            {map.edges.map((e) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x + NODE_W;
              const y2 = b.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path key={e.id} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} fill="none" stroke="currentColor"
                  strokeOpacity={0.35} strokeWidth={1.5} markerEnd="url(#dep-arrow)">
                  {e.description && <title>{e.description}</title>}
                </path>
              );
            })}
            {map.nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const go = () => navigate(resourcePath(n.kind, n.id));
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} role="link" tabIndex={0} aria-label={`${n.name} (${n.status})`}
                  className="cursor-pointer focus:outline-none" onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }}>
                  <rect width={NODE_W} height={NODE_H} rx={6} fill="var(--card)" stroke={statusStyle(n.status).fill} strokeWidth={1.5} />
                  <circle cx={12} cy={NODE_H / 2} r={4} fill={statusStyle(n.status).fill} />
                  <text x={22} y={14} fontSize={12} fill="currentColor">{n.name.length > 20 ? `${n.name.slice(0, 19)}…` : n.name}</text>
                  <text x={22} y={27} fontSize={10} fill="var(--muted-foreground)">{KIND_LABELS[n.kind] ?? n.kind}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </Card>
      <Card>
        <CardHeader><CardTitle>Dependencies by resource</CardTitle></CardHeader>
        <ul className="divide-y">
          {map.nodes.filter((n) => map.edges.some((e) => e.from === n.id)).map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
              <StatusDot status={n.status} />
              <Link to={resourcePath(n.kind, n.id)} className="font-medium hover:underline">{n.name}</Link>
              <span className="text-muted-foreground">depends on</span>
              {map.edges.filter((e) => e.from === n.id).map((e) => {
                const t = nodes.get(e.to);
                return t ? (
                  <Link key={e.id} to={resourcePath(t.kind, t.id)} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs hover:bg-accent">
                    <StatusDot status={t.status} />{t.name}
                  </Link>
                ) : null;
              })}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const tab = ["resources", "import", "map"].includes(params.get("tab") ?? "") ? (params.get("tab") as string) : "resources";
  return (
    <div>
      <PageHeader title="Inventory" description="Every monitored resource, bulk import and the dependency map." />
      <Tabs value={tab} onValueChange={(v) => setParams(v === "resources" ? {} : { tab: v }, { replace: true })}>
        <TabsList aria-label="Inventory sections">
          <TabsTrigger value="resources">Resources</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
          <TabsTrigger value="map">Dependency map</TabsTrigger>
        </TabsList>
        <TabsContent value="resources"><ResourcesTab /></TabsContent>
        <TabsContent value="import"><ImportTab /></TabsContent>
        <TabsContent value="map"><DependencyMapTab /></TabsContent>
      </Tabs>
    </div>
  );
}
