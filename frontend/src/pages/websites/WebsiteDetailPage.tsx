import { Pencil, Zap } from "lucide-react";
import * as React from "react";
import { useParams } from "react-router-dom";
import { checksApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { AvailabilityStrip } from "@/components/charts";
import { RelativeTime, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useCan } from "@/features/auth/AuthProvider";
import { ChecksPanel, DetailState, ResourceEventsPanel, ResourceHeader, ResourceIncidentsPanel, ResourceMetaCard, ResourceSettingsPanel, useResource } from "@/features/resources/panels";
import { useApiMutation } from "@/hooks/useApi";
import { SslDays, sslDaysOf } from "@/pages/services/listShared";
import { AvailabilityStats, CheckResultsCard, DETAIL_RANGES, type DetailRange, LatencyCard, ObjectTable, pickAvailability, useAvailability, useCheckTimeseries } from "@/pages/services/detailShared";
import type { Check, Resource } from "@/types/api";
import { formatMs } from "@/utils/format";
import { EditCheckDialog } from "@/pages/websites/EditCheckDialog";

function CertificatePanel({ resource, http }: { resource: Resource; http: Check | undefined }) {
  const tls = resource.checks?.find((c) => c.type === "tls");
  const certOf = (c: Check | undefined): Record<string, unknown> | null => {
    const cert = c?.last_details?.certificate;
    return cert && typeof cert === "object" && !Array.isArray(cert) ? (cert as Record<string, unknown>) : null;
  };
  const cert = certOf(tls) ?? certOf(http);
  const days = sslDaysOf(tls?.last_details) ?? sslDaysOf(http?.last_details);
  return (
    <Card>
      <CardHeader>
        <CardTitle>TLS certificate</CardTitle>
        {days !== null && <span className="text-xs">Expires in <SslDays days={days} /></span>}
      </CardHeader>
      <CardContent>
        {cert ? <ObjectTable value={cert} /> : (
          <p className="text-sm text-muted-foreground">
            {http?.config.url && String(http.config.url).startsWith("https") ? "No certificate details recorded yet." : "Not an HTTPS endpoint — no certificate to track."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function OverviewTab({ resource, check, range }: { resource: Resource; check: Check | undefined; range: DetailRange }) {
  const av = useAvailability(resource.id, range);
  const ts = useCheckTimeseries(check?.id, range);
  const checkAv = av.data?.checks.find((c) => c.check_id === check?.id);
  return (
    <div className="flex flex-col gap-4">
      {av.isLoading ? <LoadingState /> : av.isError ? <ErrorState error={av.error} onRetry={() => void av.refetch()} /> : (
        <AvailabilityStats av={pickAvailability(av.data?.resource, checkAv)} />
      )}
      {check ? (
        <>
          <Card>
            <CardHeader><CardTitle>Availability</CardTitle><span className="text-xs text-muted-foreground">{ts.data ? `${Math.round(ts.data.bucket_seconds / 60)} min buckets` : ""}</span></CardHeader>
            <CardContent>
              {ts.isLoading ? <LoadingState /> : ts.isError ? <ErrorState error={ts.error} /> : (
                <AvailabilityStrip ariaLabel="Availability per time bucket" buckets={ts.data?.points ?? []} />
              )}
            </CardContent>
          </Card>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2"><LatencyCard checkId={check.id} range={range} /></div>
            <div className="flex flex-col gap-4">
              <CertificatePanel resource={resource} http={check} />
              <ResourceMetaCard resource={resource} extra={[["Method", String(check.config.method ?? "GET")], ["Interval", `${check.interval_seconds}s`]]} />
            </div>
          </div>
          <CheckResultsCard checkId={check.id} range={range} http={check.type === "http"} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">This website has no HTTP check. Add one in the Checks tab.</p>
      )}
    </div>
  );
}

export function WebsiteDetailPage() {
  const { id } = useParams();
  const query = useResource(id);
  const [range, setRange] = React.useState<DetailRange>("24h");
  const [tab, setTab] = React.useState("overview");
  const [editOpen, setEditOpen] = React.useState(false);
  const canWrite = useCan("resources:write");
  const run = useApiMutation({ mutationFn: (cid: string) => checksApi.run(cid), success: (m) => m.message, invalidate: [qk.resources] });

  return (
    <DetailState query={query}>
      {(r) => {
        const http = r.checks?.find((c) => c.type === "http") ?? r.checks?.[0];
        return (
          <div>
            <ResourceHeader resource={r} backTo="/websites" backLabel="Websites"
              actions={
                <>
                  <Segmented label="Time range" value={range} options={DETAIL_RANGES} onChange={setRange} />
                  {canWrite && http && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}><Pencil /> Edit HTTP check</Button>
                      <Button size="sm" onClick={() => run.mutate(http.id)} loading={run.isPending} disabled={!http.enabled}><Zap /> Run now</Button>
                    </>
                  )}
                </>
              }>
              {http && (
                <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>Last result <StatusBadge status={http.last_outcome} /></span>
                  <span>{http.last_message}</span>
                  <span>{formatMs(http.last_latency_ms)}</span>
                  <span>checked <RelativeTime value={http.last_run_at} /></span>
                </p>
              )}
            </ResourceHeader>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="checks">Checks</TabsTrigger>
                <TabsTrigger value="incidents">Incidents</TabsTrigger>
                <TabsTrigger value="events">Events</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <TabsContent value="overview"><OverviewTab resource={r} check={http} range={range} /></TabsContent>
              <TabsContent value="checks"><ChecksPanel resource={r} defaultType="http" /></TabsContent>
              <TabsContent value="incidents"><ResourceIncidentsPanel resourceId={r.id} /></TabsContent>
              <TabsContent value="events"><ResourceEventsPanel resourceId={r.id} /></TabsContent>
              <TabsContent value="settings"><ResourceSettingsPanel resource={r} backTo="/websites" /></TabsContent>
            </Tabs>
            {http && <EditCheckDialog check={http} open={editOpen} onOpenChange={setEditOpen} />}
          </div>
        );
      }}
    </DetailState>
  );
}
