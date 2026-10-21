import { CalendarClock, Globe2, Pencil, Plus, ShieldCheck, Zap } from "lucide-react";
import * as React from "react";
import { useParams } from "react-router-dom";
import { checksApi, resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { AvailabilityStrip } from "@/components/charts";
import { DefinitionList, RelativeTime, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { useCan } from "@/features/auth/AuthProvider";
import { ChecksPanel, DetailState, ResourceEventsPanel, ResourceHeader, ResourceIncidentsPanel, ResourceMetaCard, ResourceSettingsPanel, useResource } from "@/features/resources/panels";
import { useApiMutation } from "@/hooks/useApi";
import { SslDays, sslDaysOf } from "@/pages/services/listShared";
import { AvailabilityStats, CheckResultsCard, DETAIL_RANGES, type DetailRange, LatencyCard, pickAvailability, useAvailability, useCheckTimeseries } from "@/pages/services/detailShared";
import type { Check, CheckIn, Resource } from "@/types/api";
import { formatDateTime, formatMs, hostOfUrl, registrableDomain } from "@/utils/format";
import { EditCheckDialog } from "@/pages/websites/EditCheckDialog";

type Obj = Record<string, unknown>;

function objOf(details: unknown, key: string): Obj | null {
  if (!details || typeof details !== "object") return null;
  const v = (details as Obj)[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "—";
  return String(v);
}

function dateOnly(v: unknown): string {
  return typeof v === "string" && v ? formatDateTime(v).split(",")[0] : "—";
}

function CheckLine({ check }: { check: Check }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <StatusBadge status={check.state} />
      <span className="min-w-0 truncate">{check.last_message || "Waiting for the first result"}</span>
      {check.last_run_at && <span>· checked <RelativeTime value={check.last_run_at} /></span>}
    </p>
  );
}

function EnableCheck({ resource, build, label }: { resource: Resource; build: () => CheckIn | null; label: string }) {
  const canWrite = useCan("resources:write");
  const add = useApiMutation({
    mutationFn: async () => {
      const body = build();
      if (!body) throw new Error("This website's URL has no hostname to check");
      return resourcesApi.addCheck(resource.id, body);
    },
    success: `${label} enabled — the first result arrives shortly`,
    invalidate: [qk.resources],
  });
  if (!canWrite) return <p className="text-sm text-muted-foreground">Not monitored. Ask an administrator to enable it.</p>;
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-muted-foreground">Not monitored yet.</p>
      <Button size="sm" variant="outline" onClick={() => add.mutate()} loading={add.isPending}><Plus /> Enable {label.toLowerCase()}</Button>
    </div>
  );
}

function urlHost(resource: Resource, http: Check | undefined): string {
  return hostOfUrl(String(http?.config.url ?? resource.address ?? ""));
}

function DnsPanel({ resource, http }: { resource: Resource; http: Check | undefined }) {
  const dns = resource.checks?.find((c) => c.type === "dns");
  const host = urlHost(resource, http);
  const ttl = dns?.last_details?.ttl;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Globe2 className="size-4" aria-hidden /> DNS</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {dns ? (
          <>
            <CheckLine check={dns} />
            <DefinitionList items={[
              ["Name", <span key="n" className="font-mono text-xs">{str(dns.config.name)}</span>],
              ["Record", str(dns.config.record_type)],
              ["Answer", <span key="a" className="break-all font-mono text-xs">{str(dns.last_details?.values)}</span>],
              ["TTL", ttl !== undefined && ttl !== null ? `${String(ttl)}s` : "—"],
              ["Lookup time", formatMs(dns.last_latency_ms)],
            ]} />
          </>
        ) : (
          <EnableCheck resource={resource} label="DNS monitoring"
            build={() => (host ? { name: "DNS", type: "dns", config: { name: host, record_type: "A" }, interval_seconds: 300, timeout_seconds: 10, failure_threshold: 2, severity: "high" } : null)} />
        )}
      </CardContent>
    </Card>
  );
}

function CertificatePanel({ resource, http }: { resource: Resource; http: Check | undefined }) {
  const tls = resource.checks?.find((c) => c.type === "tls");
  const cert = objOf(tls?.last_details, "certificate") ?? objOf(http?.last_details, "certificate");
  const days = sslDaysOf(tls?.last_details) ?? sslDaysOf(http?.last_details);
  const https = String(http?.config.url ?? "").startsWith("https");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" aria-hidden /> SSL certificate</CardTitle>
        {days !== null && <span className="text-xs">Expires in <SslDays days={days} /></span>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {cert ? (
          <DefinitionList items={[
            ["Valid until", dateOnly(cert.not_after)],
            ["Issued to", <span key="s" className="font-mono text-xs">{str(cert.subject)}</span>],
            ["Issuer", str(cert.issuer)],
            ["Covers", <span key="c" className="break-all font-mono text-xs">{str(cert.sans)}</span>],
            ["Trusted", cert.verified === false ? <span key="t" className="text-destructive">No: {str(cert.verify_error)}</span> : "Yes"],
            ["Protocol", str(cert.tls_version)],
          ]} />
        ) : (
          <p className="text-muted-foreground">{https ? "No certificate details recorded yet." : "Not an HTTPS website, so there is no certificate to track."}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DomainDays({ days }: { days: number }) {
  const cls = days < 14 ? "text-red-600 dark:text-red-400 font-semibold" : days < 30 ? "text-amber-600 dark:text-amber-400 font-medium" : "";
  return <span className={`tabular ${cls}`}>{days}d</span>;
}

function DomainPanel({ resource, http }: { resource: Resource; http: Check | undefined }) {
  const chk = resource.checks?.find((c) => c.type === "domain");
  const d = objOf(chk?.last_details, "domain");
  const days = typeof d?.days_remaining === "number" ? d.days_remaining : null;
  const host = urlHost(resource, http);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarClock className="size-4" aria-hidden /> Domain</CardTitle>
        {days !== null && <span className="text-xs">Expires in <DomainDays days={days} /></span>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {chk ? (
          <>
            <CheckLine check={chk} />
            <DefinitionList items={[
              ["Domain", <span key="d" className="font-mono text-xs">{str(chk.config.domain)}</span>],
              ["Expires", dateOnly(d?.expires_at)],
              ["Registrar", str(d?.registrar)],
              ["Name servers", <span key="ns" className="break-all font-mono text-xs">{str(d?.nameservers)}</span>],
              ["Source", str(d?.source)],
            ]} />
          </>
        ) : (
          <EnableCheck resource={resource} label="Domain expiry monitoring"
            build={() => (host ? { name: "Domain expiry", type: "domain", config: { domain: registrableDomain(host) }, interval_seconds: 43200, timeout_seconds: 30, failure_threshold: 1, severity: "critical" } : null)} />
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
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <DnsPanel resource={resource} http={check} />
            <CertificatePanel resource={resource} http={check} />
            <DomainPanel resource={resource} http={check} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2"><LatencyCard checkId={check.id} range={range} /></div>
            <div className="flex flex-col gap-4">
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
