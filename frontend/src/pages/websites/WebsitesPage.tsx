import { useQuery } from "@tanstack/react-query";
import { Globe, Plus } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { websitesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader, Pagination, RelativeTime, StatusBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useUrlFilters } from "@/hooks/useApi";
import { ResourceFilterBar, SslDays, UptimeCell, sslDaysOf } from "@/pages/services/listShared";
import { formatMs } from "@/utils/format";
import { AddWebsiteDialog } from "@/pages/websites/AddWebsiteDialog";

const FILTER_KEYS = ["q", "status", "environment", "tag", "page"] as const;
const PAGE_SIZE = 50;

export function WebsitesPage() {
  const canWrite = useCan("resources:write");
  const { values, get, set } = useUrlFilters(FILTER_KEYS);
  const [addOpen, setAddOpen] = React.useState(false);
  const page = Number(get("page")) || 1;
  const interval = useLiveInterval(60000, 30000);
  const query = {
    q: get("q") || undefined,
    status: get("status") || undefined,
    environment: get("environment") || undefined,
    tag: values.tag,
    page,
    page_size: PAGE_SIZE,
  };
  const list = useQuery({ queryKey: qk.resourceList("websites", query), queryFn: () => websitesApi.list(query), refetchInterval: interval });

  return (
    <div>
      <PageHeader
        title="Websites & APIs"
        description="HTTP(S) endpoints monitored for availability, response time, content and certificates."
        actions={canWrite && <Button onClick={() => setAddOpen(true)}><Plus /> Add website</Button>}
      >
        <ResourceFilterBar get={get} values={values} set={set} />
      </PageHeader>
      <Card>
        {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data?.items.length ? (
          <EmptyState icon={<Globe />} title="No websites match" description="Add a website or API endpoint to start monitoring it."
            action={canWrite && <Button size="sm" onClick={() => setAddOpen(true)}><Plus /> Add website</Button>} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH><TH>Status</TH><TH className="text-right">Uptime 24h</TH><TH className="text-right">Response</TH>
                  <TH className="text-right">SSL</TH><TH>Last check</TH><TH className="text-right">Incidents</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((r) => {
                  const c = r.checks?.[0];
                  return (
                    <TR key={r.id}>
                      <TD className="max-w-[360px]">
                        <Link to={`/websites/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                        {r.kind === "api" && <Badge variant="outline" className="ml-2">API</Badge>}
                        <p className="truncate font-mono text-[11px] text-muted-foreground" title={r.address}>{r.address}</p>
                      </TD>
                      <TD><StatusBadge status={r.is_paused ? "maintenance" : r.status} /></TD>
                      <TD className="text-right"><UptimeCell value={r.uptime_24h} /></TD>
                      <TD className="tabular text-right">{formatMs(c?.last_latency_ms)}</TD>
                      <TD className="text-right"><SslDays days={sslDaysOf(c?.last_details)} /></TD>
                      <TD>
                        <RelativeTime value={c?.last_run_at} />
                        {c && c.last_outcome !== "up" && <p className="max-w-[220px] truncate text-[11px] text-muted-foreground" title={c.last_message}>{c.last_message}</p>}
                      </TD>
                      <TD className="tabular text-right">
                        {r.open_incidents ? <Link className="text-red-600 hover:underline dark:text-red-400" to={`/incidents?resource_id=${r.id}&open=true`}>{r.open_incidents}</Link> : "0"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>
      <AddWebsiteDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
