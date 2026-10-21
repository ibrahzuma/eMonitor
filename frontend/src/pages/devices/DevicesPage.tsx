import { useQuery } from "@tanstack/react-query";
import { Network, Plus } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { devicesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader, Pagination, RelativeTime, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useUrlFilters } from "@/hooks/useApi";
import { ResourceFilterBar, UptimeCell } from "@/pages/services/listShared";
import type { JsonObject } from "@/types/api";
import { formatMs, humanize } from "@/utils/format";
import { AddDeviceDialog } from "@/pages/devices/AddDeviceDialog";

const FILTER_KEYS = ["q", "status", "environment", "tag", "page"] as const;
const PAGE_SIZE = 50;

function attr(a: JsonObject, k: string): string {
  const v = a[k];
  return typeof v === "string" ? v : "";
}

export function DevicesPage() {
  const canWrite = useCan("resources:write");
  const { values, get, set } = useUrlFilters(FILTER_KEYS);
  const [addOpen, setAddOpen] = React.useState(false);
  const page = Number(get("page")) || 1;
  const interval = useLiveInterval(60000, 30000);
  const query = { q: get("q") || undefined, status: get("status") || undefined, tag: values.tag, page, page_size: PAGE_SIZE };
  const list = useQuery({ queryKey: qk.resourceList("devices", query), queryFn: () => devicesApi.list(query), refetchInterval: interval });

  return (
    <div>
      <PageHeader title="Network devices" description="Routers, switches, firewalls and access points monitored via ping and SNMP."
        actions={canWrite && <Button onClick={() => setAddOpen(true)}><Plus /> Add device</Button>}>
        <ResourceFilterBar get={get} values={values} set={set} showEnvironment={false} />
      </PageHeader>
      <Card>
        {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data?.items.length ? (
          <EmptyState icon={<Network />} title="No network devices match" description="Add a device to monitor reachability, latency and interface traffic."
            action={canWrite && <Button size="sm" onClick={() => setAddOpen(true)}><Plus /> Add device</Button>} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH><TH>Host</TH><TH>Vendor / model</TH><TH>Type</TH><TH>Status</TH>
                  <TH className="text-right">Uptime 24h</TH><TH className="text-right">Latency</TH><TH>SNMP</TH><TH>Last check</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((r) => {
                  const ping = r.checks?.find((c) => c.type === "icmp");
                  const snmp = r.checks?.find((c) => c.type === "snmp");
                  const last = [ping?.last_run_at, snmp?.last_run_at].filter((x): x is string => Boolean(x)).sort().pop() ?? null;
                  return (
                    <TR key={r.id}>
                      <TD><Link to={`/network-devices/${r.id}`} className="font-medium hover:underline">{r.name}</Link></TD>
                      <TD className="font-mono text-xs">{r.address}</TD>
                      <TD className="text-xs">{[attr(r.attributes, "vendor"), attr(r.attributes, "model")].filter(Boolean).join(" ") || "—"}</TD>
                      <TD className="text-xs">{humanize(attr(r.attributes, "device_type")) || "—"}</TD>
                      <TD><StatusBadge status={r.is_paused ? "maintenance" : r.status} /></TD>
                      <TD className="text-right"><UptimeCell value={r.uptime_24h} /></TD>
                      <TD className="tabular text-right">{formatMs(ping?.last_latency_ms)}</TD>
                      <TD>{snmp ? <StatusBadge status={snmp.state} /> : <span className="text-xs text-muted-foreground">not configured</span>}</TD>
                      <TD><RelativeTime value={last} /></TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>
      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
