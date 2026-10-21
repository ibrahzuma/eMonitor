import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import * as React from "react";
import { auditApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { JsonView, PageHeader, Pagination, RelativeTime } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useDebounced } from "@/hooks/useApi";
import { formatDateTime, getDisplayTimeZone, localInputToIso } from "@/utils/format";

const ACTION_PREFIXES = ["auth.", "resource.", "server.", "website.", "check.", "incident.", "alert_rule.", "notification_channel.",
  "notification_policy.", "maintenance.", "slo.", "user.", "team.", "api_key.", "agent.", "organization."];

export function AuditPage() {
  const allowed = useCan("audit:read");
  const [action, setAction] = React.useState("");
  const [actor, setActor] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const dAction = useDebounced(action.trim(), 300);
  const dActor = useDebounced(actor.trim(), 300);
  const tz = getDisplayTimeZone();
  const params = {
    action: dAction,
    actor: dActor,
    start: start ? localInputToIso(start, tz) : null,
    end: end ? localInputToIso(end, tz) : null,
    page,
    page_size: pageSize,
  };
  React.useEffect(() => setPage(1), [dAction, dActor, start, end, pageSize]);
  const q = useQuery({ queryKey: qk.audit(params), queryFn: () => auditApi.list(params), enabled: allowed, placeholderData: keepPreviousData });

  const toggle = (id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  if (!allowed) {
    return (
      <div>
        <PageHeader title="Audit logs" />
        <EmptyState icon={<ShieldCheck aria-hidden />} title="You do not have access to audit logs" description="The audit:read permission (Organization Administrator) is required." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Audit logs" description={`Security-relevant actions in this organization. Times shown in ${tz}.`} />
      <Card className="mb-3">
        <CardContent className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Action prefix" htmlFor="audit-action">
            <Input id="audit-action" list="audit-action-prefixes" placeholder="e.g. incident." value={action} onChange={(e) => setAction(e.target.value)} />
          </Field>
          <datalist id="audit-action-prefixes">
            {ACTION_PREFIXES.map((p) => <option key={p} value={p} />)}
          </datalist>
          <Field label="Actor" htmlFor="audit-actor">
            <Input id="audit-actor" placeholder="email or API key name" value={actor} onChange={(e) => setActor(e.target.value)} />
          </Field>
          <Field label="From" htmlFor="audit-start">
            <Input id="audit-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="audit-end">
            <Input id="audit-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <div className="flex items-end gap-2">
            <Field label="Page size" htmlFor="audit-size" className="flex-1">
              <NativeSelect id="audit-size" value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))}>
                {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
              </NativeSelect>
            </Field>
            <Button variant="outline" onClick={() => { setAction(""); setActor(""); setStart(""); setEnd(""); }}>Clear</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.items.length ? (
          <EmptyState title="No audit entries match these filters" />
        ) : (
          <>
            <Table>
              <THead>
                <TR><TH className="w-8"><span className="sr-only">Expand</span></TH><TH>Time</TH><TH>Actor</TH><TH>Action</TH><TH>Target</TH><TH>IP</TH><TH>Request</TH></TR>
              </THead>
              <TBody>
                {q.data.items.map((e) => {
                  const open = expanded.has(e.id);
                  const hasDetails = Object.keys(e.details ?? {}).length > 0;
                  return (
                    <React.Fragment key={e.id}>
                      <TR>
                        <TD>
                          <Button variant="ghost" size="icon-sm" aria-expanded={open} aria-label={open ? "Hide details" : "Show details"}
                            onClick={() => toggle(e.id)} disabled={!hasDetails}>
                            {open ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        </TD>
                        <TD className="whitespace-nowrap">
                          <div className="text-xs">{formatDateTime(e.created_at, { seconds: true })}</div>
                          <div className="text-[11px] text-muted-foreground"><RelativeTime value={e.created_at} /></div>
                        </TD>
                        <TD className="max-w-[220px] truncate">{e.actor_label || "—"}</TD>
                        <TD><Badge variant="secondary" className="font-mono">{e.action}</Badge></TD>
                        <TD className="text-xs">
                          {e.target_type}
                          {e.target_id && <span className="ml-1 font-mono text-muted-foreground" title={e.target_id}>{e.target_id.slice(0, 8)}</span>}
                        </TD>
                        <TD className="font-mono text-xs">{e.ip_address || "—"}</TD>
                        <TD className="font-mono text-xs text-muted-foreground" title={e.request_id}>{e.request_id ? e.request_id.slice(0, 10) : "—"}</TD>
                      </TR>
                      {open && (
                        <TR>
                          <TD colSpan={7} className="bg-muted/30">
                            <JsonView value={e.details} />
                          </TD>
                        </TR>
                      )}
                    </React.Fragment>
                  );
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={pageSize} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
