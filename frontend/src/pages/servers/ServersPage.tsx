import { useQuery } from "@tanstack/react-query";
import { GitCompare, Plus, Search } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { serversApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { MeterCell } from "@/components/charts";
import { PageHeader, Pagination, RelativeTime, StatusBadge, TagInput } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/controls";
import { Input, NativeSelect } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { SortTH, Table, TBody, TD, TH, THead, TR, sortRows, useSort } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useDebounced, useUrlFilters } from "@/hooks/useApi";
import { ENVIRONMENTS, HEALTH_STATUSES, type Resource } from "@/types/api";
import { cn } from "@/utils/cn";
import { humanize } from "@/utils/format";
import { statusStyle } from "@/utils/status";
import { AddServerDialog } from "@/pages/servers/AddServerDialog";

const PAGE_SIZE = 50;
const FILTER_KEYS = ["status", "environment", "tag", "q", "sort", "page"] as const;

function agentLabel(r: Resource): { label: string; status: string } {
  if (!r.agent) return { label: "No agent", status: "unknown" };
  if (r.agent.status === "revoked") return { label: "Revoked", status: "revoked" };
  if (r.status === "unreachable") return { label: "Disconnected", status: "unreachable" };
  return { label: humanize(r.agent.status), status: r.agent.status === "active" ? "healthy" : "pending" };
}

type SortKey = "name" | "status" | "cpu" | "memory" | "disk" | "last_seen" | "incidents";

export function ServersPage() {
  const canWrite = useCan("resources:write");
  const navigate = useNavigate();
  const { values, get, set } = useUrlFilters(FILTER_KEYS);
  const statuses = values.status;
  const page = Math.max(1, Number(get("page")) || 1);
  const [search, setSearch] = React.useState(get("q"));
  const dq = useDebounced(search, 300);
  const [addOpen, setAddOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const { sort, onSort } = useSort<SortKey>(null);
  const interval = useLiveInterval(60000, 30000);

  React.useEffect(() => {
    if (dq !== get("q")) set({ q: dq || null });
  }, [dq, get, set]);

  const query = {
    status: statuses,
    environment: get("environment"),
    tag: values.tag,
    q: get("q"),
    sort: get("sort") || "name",
    page,
    page_size: PAGE_SIZE,
  };
  const list = useQuery({ queryKey: qk.resourceList("servers", query), queryFn: () => serversApi.list(query), refetchInterval: interval });

  const rows = sortRows(list.data?.items ?? [], sort, (r, k) => {
    const l = r.server?.latest ?? {};
    switch (k) {
      case "cpu": return l.cpu_percent;
      case "memory": return l.memory_percent;
      case "disk": return l.disk_percent_max;
      case "last_seen": return r.agent?.last_seen_at ? new Date(r.agent.last_seen_at).getTime() : null;
      case "incidents": return r.open_incidents;
      case "status": return r.status;
      default: return r.name.toLowerCase();
    }
  });

  const toggleStatus = (s: string) => set({ status: statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s] });
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  return (
    <div>
      <PageHeader
        title="Servers"
        description="Hosts monitored by the eMonitor agent and ping checks."
        actions={
          <>
            <Button variant="outline" disabled={selected.length < 2}
              onClick={() => navigate(`/servers/compare?${selected.map((id) => `id=${id}`).join("&")}`)}>
              <GitCompare /> Compare{selected.length ? ` (${selected.length})` : ""}
            </Button>
            {canWrite && <Button onClick={() => setAddOpen(true)}><Plus /> Add server</Button>}
          </>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-2.5">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search servers" placeholder="Search name or address…" value={search}
              onChange={(e) => setSearch(e.target.value)} className="pl-8" />
          </div>
          <div role="group" aria-label="Status filter" className="flex flex-wrap gap-1">
            {HEALTH_STATUSES.map((s) => {
              const on = statuses.includes(s);
              return (
                <button key={s} type="button" aria-pressed={on} onClick={() => toggleStatus(s)}
                  className={cn("inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                    on && "border-primary bg-primary/10 text-foreground")}>
                  <span className={cn("size-2 rounded-full", statusStyle(s).dot)} aria-hidden />{humanize(s)}
                </button>
              );
            })}
          </div>
          <NativeSelect aria-label="Environment filter" value={get("environment")} className="w-36"
            onChange={(e) => set({ environment: e.target.value || null })}>
            <option value="">All environments</option>
            {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
          </NativeSelect>
          <div className="w-48"><TagInput ariaLabel="Tag filter" value={values.tag} onChange={(v) => set({ tag: v })} placeholder="Filter tags…" /></div>
          <NativeSelect aria-label="Server sort order" value={get("sort") || "name"} className="w-40" onChange={(e) => set({ sort: e.target.value })}>
            <option value="name">Name A–Z</option>
            <option value="-name">Name Z–A</option>
            <option value="status">Status</option>
            <option value="-updated">Recently changed</option>
            <option value="created">Oldest first</option>
          </NativeSelect>
          {(statuses.length > 0 || get("environment") || values.tag.length > 0 || get("q")) && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(""); set({ status: null, environment: null, tag: null, q: null }); }}>Clear filters</Button>
          )}
        </div>
        {list.isLoading ? <LoadingState label="Loading servers…" /> : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !rows.length ? (
          <EmptyState title={statuses.length || get("q") || get("environment") ? "No servers match these filters" : "No servers yet"}
            description="Add a server and enroll the agent to collect CPU, memory, disk, network and log data."
            action={canWrite ? <Button size="sm" onClick={() => setAddOpen(true)}><Plus /> Add server</Button> : undefined} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="w-8">
                    <Checkbox aria-label="Select all servers on this page" checked={allSelected}
                      onCheckedChange={(v) => setSelected(v === true ? rows.map((r) => r.id) : [])} />
                  </TH>
                  <SortTH label="Server" sortKey="name" sort={sort} onSort={onSort} />
                  <SortTH label="Status" sortKey="status" sort={sort} onSort={onSort} />
                  <SortTH label="CPU" sortKey="cpu" sort={sort} onSort={onSort} />
                  <SortTH label="Memory" sortKey="memory" sort={sort} onSort={onSort} />
                  <SortTH label="Disk" sortKey="disk" sort={sort} onSort={onSort} />
                  <TH>Agent</TH>
                  <SortTH label="Last seen" sortKey="last_seen" sort={sort} onSort={onSort} />
                  <SortTH label="Incidents" sortKey="incidents" sort={sort} onSort={onSort} />
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => {
                  const l = r.server?.latest ?? {};
                  const th = r.server?.thresholds ?? {};
                  const a = agentLabel(r);
                  const sel = selected.includes(r.id);
                  return (
                    <TR key={r.id} data-state={sel ? "selected" : undefined}>
                      <TD>
                        <Checkbox aria-label={`Select ${r.name}`} checked={sel}
                          onCheckedChange={(v) => setSelected((xs) => (v === true ? [...xs, r.id] : xs.filter((x) => x !== r.id)))} />
                      </TD>
                      <TD>
                        <Link to={`/servers/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <span className="font-mono">{r.server?.ip_address || r.server?.hostname || r.address}</span>
                          <span>· {r.environment}</span>
                          {r.tags.slice(0, 3).map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
                        </div>
                      </TD>
                      <TD><StatusBadge status={r.is_paused ? "maintenance" : r.status} /></TD>
                      <TD><MeterCell value={l.cpu_percent} warn={th.cpu_percent?.warning ?? 80} crit={th.cpu_percent?.critical ?? 95} /></TD>
                      <TD><MeterCell value={l.memory_percent} warn={th.memory_percent?.warning ?? 85} crit={th.memory_percent?.critical ?? 95} /></TD>
                      <TD><MeterCell value={l.disk_percent_max} warn={th.disk_percent?.warning ?? 80} crit={th.disk_percent?.critical ?? 90} /></TD>
                      <TD>
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <span className={cn("size-2 rounded-full", statusStyle(a.status).dot)} aria-hidden />{a.label}
                          {r.agent?.version && <span className="text-muted-foreground">v{r.agent.version}</span>}
                        </span>
                      </TD>
                      <TD className="text-xs"><RelativeTime value={r.agent?.last_seen_at ?? r.server?.last_metrics_at ?? null} /></TD>
                      <TD>
                        {r.open_incidents ? (
                          <Link to={`/incidents?open=true&resource_id=${r.id}`}><Badge variant="destructive">{r.open_incidents} open</Badge></Link>
                        ) : <span className="text-xs text-muted-foreground">0</span>}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>
      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} onCreated={(r) => navigate(`/servers/${r.id}?tab=agent`)} />
    </div>
  );
}
