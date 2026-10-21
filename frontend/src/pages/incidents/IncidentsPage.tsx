import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CheckCheck, Download, Eye, Plus, Siren, X } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage } from "@/api/client";
import { incidentsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { IncidentStatusBadge, PageHeader, Pagination, RelativeTime, SeverityBadge } from "@/components/common";
import { MemberSelect, MultiSelect, ResourceSelect } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, CheckboxField } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { fieldErrorsOf, useApiMutation, useDebounced, useUrlFilters } from "@/hooks/useApi";
import { INCIDENT_SOURCES, INCIDENT_STATUSES, type ManualIncidentIn, SEVERITIES, type Severity } from "@/types/api";
import { formatDuration, humanize, isoToLocalInput, localInputToIso } from "@/utils/format";
import { resourcePath } from "@/utils/status";

const FILTER_KEYS = ["status", "severity", "source", "assignee_id", "open", "q", "start", "end", "sort", "page"] as const;
const PAGE_SIZE = 50;
const SORTS = [
  { value: "-created", label: "Newest first" },
  { value: "created", label: "Oldest first" },
  { value: "-last_detected", label: "Last detected" },
  { value: "-number", label: "Number (desc)" },
  { value: "severity", label: "Severity" },
];

function NewIncidentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [form, setForm] = React.useState<{ title: string; description: string; severity: Severity; resource_id: string; assignee_id: string }>(
    { title: "", description: "", severity: "warning", resource_id: "", assignee_id: "" });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setForm({ title: "", description: "", severity: "warning", resource_id: "", assignee_id: "" });
      setErrors({});
    }
  }, [open]);
  const create = useApiMutation({
    mutationFn: (body: ManualIncidentIn) => incidentsApi.create(body),
    invalidate: [qk.incidents, qk.dashboard],
    success: (inc) => `Created INC-${inc.number}`,
    errorTitle: "Could not create incident",
    onSuccess: (inc) => {
      onOpenChange(false);
      navigate(`/incidents/${inc.id}`);
    },
    onError: (e) => setErrors(fieldErrorsOf(e)),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.title.trim().length < 3) {
      setErrors({ title: "Title must be at least 3 characters" });
      return;
    }
    create.mutate({
      title: form.title.trim(),
      description: form.description,
      severity: form.severity,
      resource_id: form.resource_id || null,
      assignee_id: form.assignee_id || null,
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New incident</DialogTitle>
          <DialogDescription>Declare an incident manually (e.g. reported by a customer).</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="flex flex-col gap-3">
            <Field label="Title" htmlFor="ni-title" error={errors.title} required>
              <Input id="ni-title" value={form.title} maxLength={300} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Description" htmlFor="ni-desc" error={errors.description}>
              <Textarea id="ni-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Severity" htmlFor="ni-sev">
                <NativeSelect id="ni-sev" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Resource" htmlFor="ni-res" error={errors.resource_id}>
                <ResourceSelect id="ni-res" value={form.resource_id} onChange={(v) => setForm({ ...form, resource_id: v })} />
              </Field>
              <Field label="Assignee" htmlFor="ni-assignee" error={errors.assignee_id}>
                <MemberSelect id="ni-assignee" value={form.assignee_id} onChange={(v) => setForm({ ...form, assignee_id: v })} />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create incident</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BulkResolveDialog({ open, onOpenChange, count, onConfirm, loading }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  count: number;
  onConfirm: (note: string) => void;
  loading: boolean;
}) {
  const [note, setNote] = React.useState("");
  React.useEffect(() => {
    if (open) setNote("");
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Resolve {count} incident{count === 1 ? "" : "s"}</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); onConfirm(note.trim()); }} className="contents">
          <DialogBody>
            <Field label="Resolution note" htmlFor="bulk-note" hint="Recorded on every selected incident">
              <Textarea id="bulk-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Root cause fixed by…" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={loading}>Resolve</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function IncidentsPage() {
  const canOperate = useCan("incidents:operate");
  const canBulk = useCan("incidents:bulk") && canOperate;
  const toast = useToast();
  const { values, get, set } = useUrlFilters(FILTER_KEYS);
  const [qDraft, setQDraft] = React.useState(get("q"));
  const dq = useDebounced(qDraft, 300);
  React.useEffect(() => {
    if (dq !== get("q")) set({ q: dq || null });
  }, [dq, get, set]);

  const page = Math.max(1, Number(get("page")) || 1);
  const query = {
    status: values.status,
    severity: values.severity,
    source: values.source,
    assignee_id: get("assignee_id") || undefined,
    open: get("open") === "true" ? true : undefined,
    q: get("q") || undefined,
    start: get("start") || undefined,
    end: get("end") || undefined,
    sort: get("sort") || "-created",
    page,
    page_size: PAGE_SIZE,
  };
  const interval = useLiveInterval(60000, 30000);
  const list = useQuery({
    queryKey: qk.incidentList(query),
    queryFn: () => incidentsApi.list(query),
    refetchInterval: interval,
    placeholderData: keepPreviousData,
  });

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [newOpen, setNewOpen] = React.useState(false);
  const [resolveOpen, setResolveOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const items = list.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = items.some((i) => selected.has(i.id));

  const bulk = useApiMutation({
    mutationFn: (v: { action: "acknowledge" | "resolve"; note: string }) => incidentsApi.bulk([...selected], v.action, v.note),
    invalidate: [qk.incidents, qk.dashboard],
    success: (r, v) => `${v.action === "acknowledge" ? "Acknowledged" : "Resolved"} ${r.updated} incident${r.updated === 1 ? "" : "s"}`
      + (r.not_found ? ` (${r.not_found} not found)` : ""),
    errorTitle: "Bulk action failed",
    onSuccess: () => {
      setSelected(new Set());
      setResolveOpen(false);
    },
  });

  const doExport = async () => {
    setExporting(true);
    try {
      const name = await incidentsApi.export({ status: values.status, severity: values.severity, q: query.q, start: query.start, end: query.end });
      toast.success("Export downloaded", name);
    } catch (e) {
      toast.error("Export failed", errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const hasFilters = FILTER_KEYS.some((k) => k !== "sort" && k !== "page" && values[k].length > 0);

  return (
    <div>
      <PageHeader
        title="Incidents"
        description={list.data ? `${list.data.total} incident${list.data.total === 1 ? "" : "s"} match` : "Detected problems and their lifecycle"}
        actions={
          <>
            <Button variant="outline" onClick={() => void doExport()} loading={exporting}><Download /> Export CSV</Button>
            {canOperate && <Button onClick={() => setNewOpen(true)}><Plus /> New incident</Button>}
          </>
        }
      />
      <Card className="mb-3">
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <Field label="Search" htmlFor="inc-q" className="sm:col-span-2">
            <Input id="inc-q" type="search" placeholder="Title, condition or INC-123" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
          </Field>
          <div className="flex flex-col gap-1">
            <label htmlFor="inc-status" className="text-xs font-medium">Status</label>
            <MultiSelect id="inc-status" ariaLabel="Status filter" value={values.status} onChange={(v) => set({ status: v })} placeholder="Any status"
              options={INCIDENT_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="inc-sev" className="text-xs font-medium">Severity</label>
            <MultiSelect id="inc-sev" ariaLabel="Severity filter" value={values.severity} onChange={(v) => set({ severity: v })} placeholder="Any severity"
              options={SEVERITIES.map((s) => ({ value: s, label: s }))} />
          </div>
          <Field label="Source" htmlFor="inc-source">
            <NativeSelect id="inc-source" value={get("source")} onChange={(e) => set({ source: e.target.value || null })}>
              <option value="">Any source</option>
              {INCIDENT_SOURCES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Assignee" htmlFor="inc-assignee">
            <MemberSelect id="inc-assignee" value={get("assignee_id")} onChange={(v) => set({ assignee_id: v || null })} emptyLabel="Anyone" />
          </Field>
          <Field label="From" htmlFor="inc-start">
            <Input id="inc-start" type="datetime-local" value={isoToLocalInput(get("start"))}
              onChange={(e) => set({ start: localInputToIso(e.target.value) })} />
          </Field>
          <Field label="To" htmlFor="inc-end">
            <Input id="inc-end" type="datetime-local" value={isoToLocalInput(get("end"))}
              onChange={(e) => set({ end: localInputToIso(e.target.value) })} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t px-3 py-2">
          <CheckboxField id="inc-open" label="Open incidents only" checked={get("open") === "true"} onCheckedChange={(v) => set({ open: v ? "true" : null })} />
          <div className="flex items-center gap-2">
            <label htmlFor="inc-sort" className="text-xs text-muted-foreground">Sort</label>
            <NativeSelect id="inc-sort" className="w-40" value={get("sort") || "-created"} onChange={(e) => set({ sort: e.target.value })}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </NativeSelect>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={() => { setQDraft(""); set({ status: null, severity: null, source: null, assignee_id: null, open: null, q: null, start: null, end: null }); }}>
              <X /> Clear filters
            </Button>
          )}
        </div>
      </Card>

      {canBulk && selected.size > 0 && (
        <div role="region" aria-label="Bulk actions" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" loading={bulk.isPending && bulk.variables?.action === "acknowledge"}
            onClick={() => bulk.mutate({ action: "acknowledge", note: "" })}><Eye /> Acknowledge</Button>
          <Button size="sm" variant="outline" onClick={() => setResolveOpen(true)}><CheckCheck /> Resolve</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      <Card>
        {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !items.length ? (
          <EmptyState icon={<Siren />} title={hasFilters ? "No incidents match these filters" : "No incidents"}
            description={hasFilters ? "Try widening the filters." : "Incidents appear here when checks, rules or agents detect problems."} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  {canBulk && (
                    <TH className="w-8">
                      <Checkbox aria-label="Select all incidents on this page" checked={allSelected ? true : someSelected ? "indeterminate" : false}
                        onCheckedChange={(v) => setSelected((prev) => {
                          const next = new Set(prev);
                          items.forEach((i) => (v === true ? next.add(i.id) : next.delete(i.id)));
                          return next;
                        })} />
                    </TH>
                  )}
                  <TH>Incident</TH><TH>Severity</TH><TH>Status</TH><TH>Resource</TH><TH>Assignee</TH><TH>Detected</TH><TH>Duration</TH><TH className="text-right">Occurrences</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((i) => (
                  <TR key={i.id} data-state={selected.has(i.id) ? "selected" : undefined}>
                    {canBulk && (
                      <TD>
                        <Checkbox aria-label={`Select INC-${i.number}`} checked={selected.has(i.id)}
                          onCheckedChange={(v) => setSelected((prev) => {
                            const next = new Set(prev);
                            if (v === true) next.add(i.id);
                            else next.delete(i.id);
                            return next;
                          })} />
                      </TD>
                    )}
                    <TD className="max-w-[420px]">
                      <Link to={`/incidents/${i.id}`} className="flex items-baseline gap-2 hover:underline">
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">INC-{i.number}</span>
                        <span className="truncate font-medium">{i.title}</span>
                      </Link>
                      {i.in_maintenance && <span className="text-[11px] text-sky-600">in maintenance</span>}
                    </TD>
                    <TD><SeverityBadge severity={i.severity} /></TD>
                    <TD><IncidentStatusBadge status={i.status} /></TD>
                    <TD className="max-w-[200px] truncate">
                      {i.resource_id && i.resource_name ? (
                        <Link className="hover:underline" to={resourcePath(i.resource_kind, i.resource_id)}>{i.resource_name}</Link>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TD>
                    <TD className="max-w-[160px] truncate">{i.assignee_name ?? <span className="text-muted-foreground">Unassigned</span>}</TD>
                    <TD className="text-xs"><RelativeTime value={i.first_detected_at} /></TD>
                    <TD className="tabular text-xs">{formatDuration(i.duration_seconds)}</TD>
                    <TD className="tabular text-right">{i.occurrence_count}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Card>

      <NewIncidentDialog open={newOpen} onOpenChange={setNewOpen} />
      <BulkResolveDialog open={resolveOpen} onOpenChange={setResolveOpen} count={selected.size} loading={bulk.isPending}
        onConfirm={(note) => bulk.mutate({ action: "resolve", note })} />
    </div>
  );
}
