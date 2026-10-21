import { useQuery } from "@tanstack/react-query";
import { AppWindow, Plus } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { servicesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader, Pagination, StatusBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { CHECK_TYPE_LABELS } from "@/features/checks/checkSpecs";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useUrlFilters } from "@/hooks/useApi";
import { ResourceFilterBar, UptimeCell } from "@/pages/services/listShared";
import { KIND_LABELS } from "@/utils/status";
import { AddServiceDialog, SERVICE_KINDS } from "@/pages/services/AddServiceDialog";

const FILTER_KEYS = ["q", "status", "environment", "tag", "page", "kind"] as const;
const PAGE_SIZE = 50;

export function ServicesPage() {
  const canWrite = useCan("resources:write");
  const { values, get, set } = useUrlFilters(FILTER_KEYS);
  const [addOpen, setAddOpen] = React.useState(false);
  const page = Number(get("page")) || 1;
  const interval = useLiveInterval(60000, 30000);
  const query = {
    q: get("q") || undefined,
    status: get("status") || undefined,
    kind: values.kind.length ? values.kind : undefined,
    tag: values.tag,
    page,
    page_size: PAGE_SIZE,
  };
  const list = useQuery({ queryKey: qk.resourceList("services", query), queryFn: () => servicesApi.list(query), refetchInterval: interval });

  return (
    <div>
      <PageHeader title="Applications & services" description="Databases, applications, APIs and network services monitored with active checks."
        actions={canWrite && <Button onClick={() => setAddOpen(true)}><Plus /> Add service</Button>}>
        <ResourceFilterBar get={get} values={values} set={set} showEnvironment={false} extra={
          <NativeSelect aria-label="Kind filter" value={get("kind")} onChange={(e) => set({ kind: e.target.value || null })} className="w-40">
            <option value="">Services, DBs & apps</option>
            {SERVICE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </NativeSelect>
        } />
      </PageHeader>
      <Card>
        {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data?.items.length ? (
          <EmptyState icon={<AppWindow />} title="No services match" description="Add a service with one or more checks (TCP, DNS, database, Redis, SMTP …)."
            action={canWrite && <Button size="sm" onClick={() => setAddOpen(true)}><Plus /> Add service</Button>} />
        ) : (
          <>
            <Table>
              <THead>
                <TR><TH>Name</TH><TH>Kind</TH><TH>Status</TH><TH>Checks</TH><TH className="text-right">Uptime 24h</TH><TH className="text-right">Incidents</TH></TR>
              </THead>
              <TBody>
                {list.data.items.map((r) => {
                  const checks = r.checks ?? [];
                  const failing = checks.filter((c) => c.enabled && (c.last_outcome === "down" || c.last_outcome === "degraded"));
                  return (
                    <TR key={r.id}>
                      <TD>
                        <Link to={`/services/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        {r.address && <p className="truncate font-mono text-[11px] text-muted-foreground">{r.address}</p>}
                      </TD>
                      <TD><Badge variant="outline">{KIND_LABELS[r.kind] ?? r.kind}</Badge></TD>
                      <TD><StatusBadge status={r.is_paused ? "maintenance" : r.status} /></TD>
                      <TD>
                        <div className="flex flex-wrap items-center gap-1 text-xs">
                          <span className="tabular">{checks.length}</span>
                          {failing.length > 0 && <Badge variant="destructive">{failing.length} failing</Badge>}
                          {checks.slice(0, 4).map((c) => <Badge key={c.id} variant="secondary" title={c.last_message}>{CHECK_TYPE_LABELS[c.type] ?? c.type}</Badge>)}
                        </div>
                      </TD>
                      <TD className="text-right"><UptimeCell value={r.uptime_24h} /></TD>
                      <TD className="tabular text-right">{r.open_incidents ?? 0}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>
      <AddServiceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
