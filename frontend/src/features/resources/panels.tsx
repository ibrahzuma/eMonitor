import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Pause, Play, Plus, Trash2, Zap } from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { checksApi, incidentsApi, logsApi, resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import {
  DefinitionList,
  IncidentStatusBadge,
  Pagination,
  RelativeTime,
  SeverityBadge,
  StatusBadge,
  TagInput,
} from "@/components/common";
import { GroupSelect, PolicySelect, ResourceSelect, TeamSelect } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { CheckEditor } from "@/features/checks/CheckEditor";
import { CHECK_TYPE_LABELS, type CheckDraft, checkToDraft, defaultCheckDraft, draftToCheckIn, serverErrorsForCheck } from "@/features/checks/checkSpecs";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import { type Check, type CheckType, ENVIRONMENTS, type Environment, type Resource } from "@/types/api";
import { formatDateTime, formatDuration, formatMs, humanize } from "@/utils/format";
import { KIND_LABELS, LOG_SEVERITY_COLORS, resourcePath } from "@/utils/status";

// ---------------------------------------------------------------- data hook

export function useResource(id: string | undefined) {
  const interval = useLiveInterval(60000, 30000);
  return useQuery({
    queryKey: qk.resource(id ?? ""),
    queryFn: () => resourcesApi.get(id ?? ""),
    enabled: Boolean(id),
    refetchInterval: interval,
  });
}

// ---------------------------------------------------------------- header

export function ResourceHeader({ resource, backTo, backLabel, actions, children }: {
  resource: Resource;
  backTo: string;
  backLabel: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2">
      <Link to={backTo} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> {backLabel}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight">{resource.name}</h1>
            <StatusBadge status={resource.is_paused ? "maintenance" : resource.status} />
            {resource.is_paused && <Badge variant="info">Paused</Badge>}
            <Badge variant="outline">{KIND_LABELS[resource.kind] ?? resource.kind}</Badge>
            <Badge variant="outline">{resource.environment}</Badge>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {resource.address && <span className="font-mono">{resource.address}</span>}
            {resource.status_reason && <span>{resource.status_reason}</span>}
            <span>Status since <RelativeTime value={resource.status_changed_at} /></span>
            {resource.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
          </p>
          {children}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- checks

function CheckDialog({ open, onOpenChange, resource, check, defaultType }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  resource: Resource;
  check?: Check | null;
  defaultType?: CheckType;
}) {
  const [draft, setDraft] = React.useState<CheckDraft>(() => (check ? checkToDraft(check) : defaultCheckDraft(defaultType ?? "tcp")));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setDraft(check ? checkToDraft(check) : defaultCheckDraft(defaultType ?? "tcp"));
      setErrors({});
    }
  }, [open, check, defaultType]);

  const save = useApiMutation({
    mutationFn: async (d: CheckDraft) => {
      const { payload, errors: errs } = draftToCheckIn(d);
      if (!payload) {
        setErrors(errs);
        throw new Error("Please fix the highlighted fields");
      }
      if (check) {
        const { type: _t, ...rest } = payload;
        return checksApi.update(check.id, rest);
      }
      return resourcesApi.addCheck(resource.id, payload);
    },
    invalidate: [qk.resources, qk.checks],
    success: check ? "Check updated" : "Check added",
    errorTitle: "Could not save check",
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      if (Object.keys(fe).length) setErrors((prev) => ({ ...prev, ...serverErrorsForCheck(fe) }));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{check ? `Edit check “${check.name}”` : "Add check"}</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }} className="contents" noValidate>
          <DialogBody>
            <CheckEditor value={draft} onChange={setDraft} errors={errors} idPrefix="chk" lockType={Boolean(check)} hasSecrets={check?.has_secrets} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{check ? "Save check" : "Add check"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ChecksPanel({ resource, defaultType, onSelectCheck, selectedCheckId }: {
  resource: Resource;
  defaultType?: CheckType;
  onSelectCheck?: (c: Check) => void;
  selectedCheckId?: string;
}) {
  const canWrite = useCan("resources:write");
  const checks = resource.checks ?? [];
  const [editing, setEditing] = React.useState<Check | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Check | null>(null);

  const run = useApiMutation({ mutationFn: (id: string) => checksApi.run(id), success: (m) => m.message, invalidate: [qk.resources] });
  const toggle = useApiMutation({
    mutationFn: (c: Check) => checksApi.update(c.id, { enabled: !c.enabled }),
    success: (c) => (c.enabled ? "Check enabled" : "Check disabled"),
    invalidate: [qk.resources, qk.checks],
  });
  const remove = useApiMutation({
    mutationFn: (id: string) => checksApi.remove(id),
    success: "Check deleted",
    invalidate: [qk.resources, qk.checks],
    onSuccess: () => setDeleting(null),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Checks ({checks.length})</CardTitle>
        {canWrite && (
          <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus /> Add check</Button>
        )}
      </CardHeader>
      {!checks.length ? (
        <EmptyState title="No checks configured" description="Add a check to start active monitoring of this resource." />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH><TH>Type</TH><TH>State</TH><TH>Last result</TH><TH>Latency</TH><TH>Last run</TH><TH>Interval</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {checks.map((c) => (
              <TR key={c.id} data-state={selectedCheckId === c.id ? "selected" : undefined}>
                <TD className="font-medium">
                  {onSelectCheck ? (
                    <button type="button" className="text-left hover:underline" onClick={() => onSelectCheck(c)}>{c.name}</button>
                  ) : c.name}
                  {!c.enabled && <Badge variant="outline" className="ml-2">disabled</Badge>}
                  {c.has_secrets && <Badge variant="outline" className="ml-1">credentials</Badge>}
                </TD>
                <TD>{CHECK_TYPE_LABELS[c.type] ?? c.type}</TD>
                <TD><StatusBadge status={c.state} /></TD>
                <TD className="max-w-[320px]">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={c.last_outcome} />
                    <span className="truncate text-xs text-muted-foreground" title={c.last_message}>{c.last_message}</span>
                  </div>
                </TD>
                <TD className="tabular">{formatMs(c.last_latency_ms)}</TD>
                <TD><RelativeTime value={c.last_run_at} /></TD>
                <TD className="tabular">{formatDuration(c.interval_seconds)}</TD>
                <TD className="text-right">
                  {canWrite && (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => run.mutate(c.id)} disabled={!c.enabled} aria-label={`Run ${c.name} now`}>
                        <Zap /> Run now
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditing(c); setDialogOpen(true); }}>Edit</Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => toggle.mutate(c)} aria-label={c.enabled ? `Disable ${c.name}` : `Enable ${c.name}`}>
                        {c.enabled ? <Pause /> : <Play />}
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`}>
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <CheckDialog open={dialogOpen} onOpenChange={setDialogOpen} resource={resource} check={editing} defaultType={defaultType} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete check “${deleting?.name ?? ""}”?`}
        description="The check stops running. Historical results are kept until retention expires." destructive confirmLabel="Delete"
        loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- incidents

export function ResourceIncidentsPanel({ resourceId }: { resourceId: string }) {
  const [page, setPage] = React.useState(1);
  const q = useQuery({
    queryKey: qk.incidentList({ resource_id: resourceId, page }),
    queryFn: () => incidentsApi.list({ resource_id: resourceId, page, page_size: 20 }),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Incidents</CardTitle></CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.items.length ? (
        <EmptyState title="No incidents for this resource" />
      ) : (
        <>
          <Table>
            <THead><TR><TH>Incident</TH><TH>Severity</TH><TH>Status</TH><TH>Detected</TH><TH>Duration</TH></TR></THead>
            <TBody>
              {q.data.items.map((i) => (
                <TR key={i.id}>
                  <TD><Link to={`/incidents/${i.id}`} className="hover:underline"><span className="font-mono text-xs text-muted-foreground">INC-{i.number}</span> {i.title}</Link></TD>
                  <TD><SeverityBadge severity={i.severity} /></TD>
                  <TD><IncidentStatusBadge status={i.status} /></TD>
                  <TD><RelativeTime value={i.first_detected_at} /></TD>
                  <TD className="tabular">{formatDuration(i.duration_seconds)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={20} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- events

export function ResourceEventsPanel({ resourceId }: { resourceId: string }) {
  const [range, setRange] = React.useState<"24h" | "7d" | "30d">("7d");
  const q = useQuery({ queryKey: qk.resourceEvents(resourceId, range), queryFn: () => resourcesApi.events(resourceId, range, 500) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Events</CardTitle>
        <Segmented label="Event range" value={range} options={["24h", "7d", "30d"] as const} onChange={setRange} />
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No events in this range" description="State changes, incidents and agent events appear here." />
      ) : (
        <ul className="divide-y">
          {q.data.map((e) => (
            <li key={e.id} className="flex flex-col gap-0.5 px-4 py-2 sm:flex-row sm:items-start sm:gap-3">
              <span className="w-40 shrink-0 text-xs text-muted-foreground">{formatDateTime(e.ts, { seconds: true })}</span>
              <span className="w-28 shrink-0"><Badge variant="outline">{humanize(e.kind)}</Badge></span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{e.title}</span>
                {e.message && <span className="text-muted-foreground"> — {e.message}</span>}
              </span>
              {e.severity && <SeverityBadge severity={e.severity} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- logs

export function ResourceLogsPanel({ resourceId }: { resourceId: string }) {
  const [range, setRange] = React.useState<"1h" | "6h" | "24h" | "7d">("24h");
  const q = useQuery({
    queryKey: qk.logSearch({ resource_id: resourceId, range, scope: "resource" }),
    queryFn: () => logsApi.search({ resource_id: [resourceId], range, limit: 100 }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent logs</CardTitle>
        <div className="flex items-center gap-2">
          <Segmented label="Log range" value={range} options={["1h", "6h", "24h", "7d"] as const} onChange={setRange} />
          <Button asChild variant="outline" size="sm"><Link to={`/logs?resource_id=${resourceId}&range=${range}`}>Open in Logs</Link></Button>
        </div>
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.items.length ? (
        <EmptyState title="No logs for this resource in range" description="Logs shipped by the agent or the ingestion API with this resource id appear here." />
      ) : (
        <ul className="divide-y font-mono text-xs">
          {q.data.items.map((l) => (
            <li key={l.id} className="flex gap-3 px-4 py-1.5">
              <span className="shrink-0 text-muted-foreground">{formatDateTime(l.ts, { seconds: true })}</span>
              <span className="w-16 shrink-0 font-semibold uppercase" style={{ color: LOG_SEVERITY_COLORS[l.severity] }}>{l.severity}</span>
              <span className="shrink-0 text-muted-foreground">{l.application || l.source}</span>
              <span className="min-w-0 flex-1 break-all">{l.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- dependencies

export function DependenciesPanel({ resource }: { resource: Resource }) {
  const canWrite = useCan("resources:write");
  const deps = useQuery({ queryKey: qk.resourceDependencies(resource.id), queryFn: () => resourcesApi.dependencies(resource.id) });
  const all = useQuery({ queryKey: qk.resourceList("deps", {}), queryFn: () => resourcesApi.list({ page_size: 500 }) });
  const [target, setTarget] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const names = new Map((all.data?.items ?? []).map((r) => [r.id, r] as const));
  const add = useApiMutation({
    mutationFn: () => resourcesApi.addDependency(resource.id, target, desc),
    success: "Dependency added",
    invalidate: [qk.resourceDependencies(resource.id), qk.dependencyMap],
    onSuccess: () => { setTarget(""); setDesc(""); },
  });
  const remove = useApiMutation({
    mutationFn: (depId: string) => resourcesApi.removeDependency(resource.id, depId),
    success: "Dependency removed",
    invalidate: [qk.resourceDependencies(resource.id), qk.dependencyMap],
  });
  const link = (id: string) => {
    const r = names.get(id);
    return r ? <Link className="hover:underline" to={resourcePath(r.kind, r.id)}>{r.name}</Link> : <span className="font-mono text-xs">{id.slice(0, 8)}</span>;
  };
  return (
    <Card>
      <CardHeader><CardTitle>Dependencies</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {deps.isLoading ? <LoadingState /> : deps.isError ? <ErrorState error={deps.error} /> : !deps.data?.length ? (
          <p className="text-sm text-muted-foreground">No dependencies recorded. Dependencies suppress downstream alerts and power the dependency map.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {deps.data.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                {d.resource_id === resource.id ? <>depends on {link(d.depends_on_id)}</> : <>{link(d.resource_id)} depends on this</>}
                {d.description && <span className="text-xs text-muted-foreground">({d.description})</span>}
                {canWrite && (
                  <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Remove dependency" onClick={() => remove.mutate(d.id)}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (target) add.mutate(); }}>
            <Field label="Depends on" htmlFor="dep-target" className="min-w-[220px] flex-1">
              <ResourceSelect id="dep-target" value={target} onChange={setTarget} emptyLabel="Select a resource…" />
            </Field>
            <Field label="Description" htmlFor="dep-desc" className="min-w-[180px] flex-1">
              <Input id="dep-desc" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} />
            </Field>
            <Button type="submit" variant="outline" disabled={!target || target === resource.id} loading={add.isPending}>Add dependency</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- settings (generic resource fields)

export interface BaseFieldsState {
  name: string;
  description: string;
  address: string;
  environment: Environment;
  location: string;
  business_owner: string;
  group_id: string;
  team_id: string;
  tags: string[];
  notification_policy_id: string;
}

export function baseFieldsFrom(r?: Resource | null): BaseFieldsState {
  return {
    name: r?.name ?? "",
    description: r?.description ?? "",
    address: r?.address ?? "",
    environment: ((r?.environment as Environment) ?? "production"),
    location: r?.location ?? "",
    business_owner: r?.business_owner ?? "",
    group_id: r?.group_id ?? "",
    team_id: r?.team_id ?? "",
    tags: r?.tags ?? [],
    notification_policy_id: typeof r?.attributes?.notification_policy_id === "string" ? r.attributes.notification_policy_id : "",
  };
}

export function baseFieldsPayload(s: BaseFieldsState, opts: { includeAddress?: boolean } = {}) {
  return {
    name: s.name.trim(),
    description: s.description,
    ...(opts.includeAddress ? { address: s.address.trim() } : {}),
    environment: s.environment,
    location: s.location,
    business_owner: s.business_owner,
    group_id: s.group_id || null,
    team_id: s.team_id || null,
    tags: s.tags,
    notification_policy_id: s.notification_policy_id || null,
  };
}

/** Shared inputs for name, description, environment, location, owner, group, team, tags and notification policy. */
export function BaseResourceFields({ value, onChange, errors, idPrefix, showAddress, showDescription = true }: {
  value: BaseFieldsState;
  onChange: (v: BaseFieldsState) => void;
  errors: Record<string, string>;
  idPrefix: string;
  showAddress?: boolean;
  showDescription?: boolean;
}) {
  const set = <K extends keyof BaseFieldsState>(k: K, v: BaseFieldsState[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Name" htmlFor={`${idPrefix}-name`} error={errors.name} required>
        <Input id={`${idPrefix}-name`} value={value.name} onChange={(e) => set("name", e.target.value)} maxLength={200} />
      </Field>
      <Field label="Environment" htmlFor={`${idPrefix}-env`} error={errors.environment}>
        <NativeSelect id={`${idPrefix}-env`} value={value.environment} onChange={(e) => set("environment", e.target.value as Environment)}>
          {ENVIRONMENTS.map((e) => <option key={e} value={e}>{humanize(e)}</option>)}
        </NativeSelect>
      </Field>
      {showAddress && (
        <Field label="Address" htmlFor={`${idPrefix}-address`} error={errors.address} className="sm:col-span-2">
          <Input id={`${idPrefix}-address`} value={value.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
      )}
      {showDescription && (
        <Field label="Description" htmlFor={`${idPrefix}-desc`} error={errors.description} className="sm:col-span-2">
          <Textarea id={`${idPrefix}-desc`} value={value.description} onChange={(e) => set("description", e.target.value)} rows={2} />
        </Field>
      )}
      <Field label="Location" htmlFor={`${idPrefix}-loc`} error={errors.location}>
        <Input id={`${idPrefix}-loc`} value={value.location} onChange={(e) => set("location", e.target.value)} placeholder="eu-west-1, Rack 12…" />
      </Field>
      <Field label="Business owner" htmlFor={`${idPrefix}-owner`} error={errors.business_owner}>
        <Input id={`${idPrefix}-owner`} value={value.business_owner} onChange={(e) => set("business_owner", e.target.value)} />
      </Field>
      <Field label="Group" htmlFor={`${idPrefix}-group`} error={errors.group_id}>
        <GroupSelect id={`${idPrefix}-group`} value={value.group_id} onChange={(v) => set("group_id", v)} />
      </Field>
      <Field label="Team" htmlFor={`${idPrefix}-team`} error={errors.team_id}>
        <TeamSelect id={`${idPrefix}-team`} value={value.team_id} onChange={(v) => set("team_id", v)} />
      </Field>
      <Field label="Tags" htmlFor={`${idPrefix}-tags`} error={errors.tags} hint="Letters, digits and _ . : / -">
        <TagInput id={`${idPrefix}-tags`} value={value.tags} onChange={(v) => set("tags", v)} />
      </Field>
      <Field label="Notification policy" htmlFor={`${idPrefix}-policy`} error={errors.notification_policy_id}>
        <PolicySelect id={`${idPrefix}-policy`} value={value.notification_policy_id} onChange={(v) => set("notification_policy_id", v)} />
      </Field>
    </div>
  );
}

export function ResourceSettingsPanel({ resource, backTo, extra }: {
  resource: Resource;
  backTo: string;
  /** Optional additional section rendered above the danger zone (e.g. server-specific settings). */
  extra?: React.ReactNode;
}) {
  const canWrite = useCan("resources:write");
  const navigate = useNavigate();
  const [state, setState] = React.useState<BaseFieldsState>(() => baseFieldsFrom(resource));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  React.useEffect(() => setState(baseFieldsFrom(resource)), [resource]);

  const save = useApiMutation({
    mutationFn: () => {
      if (!state.name.trim()) {
        setErrors({ name: "Name is required" });
        throw new Error("Name is required");
      }
      setErrors({});
      return resourcesApi.update(resource.id, baseFieldsPayload(state, { includeAddress: true }));
    },
    success: "Resource updated",
    invalidate: [qk.resources],
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  const pause = useApiMutation({
    mutationFn: () => resourcesApi.update(resource.id, { is_paused: !resource.is_paused }),
    success: resource.is_paused ? "Monitoring resumed" : "Monitoring paused",
    invalidate: [qk.resources],
  });
  const remove = useApiMutation({
    mutationFn: () => resourcesApi.remove(resource.id),
    success: (m) => m.message,
    invalidate: [qk.resources, qk.dashboard],
    onSuccess: () => navigate(backTo),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><CardTitle>General</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="flex flex-col gap-4" noValidate>
            <fieldset disabled={!canWrite} className="contents">
              <BaseResourceFields value={state} onChange={setState} errors={errors} idPrefix="res" showAddress />
            </fieldset>
            {canWrite && <div><Button type="submit" loading={save.isPending}>Save changes</Button></div>}
          </form>
        </CardContent>
      </Card>
      {extra}
      <DependenciesPanel resource={resource} />
      {canWrite && (
        <Card className="border-destructive/30">
          <CardHeader><CardTitle>Monitoring & danger zone</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{resource.is_paused ? "Monitoring is paused" : "Pause monitoring"}</p>
                <p className="text-xs text-muted-foreground">Paused resources do not run checks or raise incidents.</p>
              </div>
              <Button variant="outline" onClick={() => pause.mutate()} loading={pause.isPending}>
                {resource.is_paused ? <><Play /> Resume monitoring</> : <><Pause /> Pause monitoring</>}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div>
                <p className="text-sm font-medium">Delete resource</p>
                <p className="text-xs text-muted-foreground">Removes the resource and its checks. Historical telemetry expires with retention.</p>
              </div>
              <Button variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</Button>
            </div>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete “${resource.name}”?`} destructive
        confirmLabel="Delete resource" loading={remove.isPending} onConfirm={() => remove.mutate()} />
    </div>
  );
}

// ---------------------------------------------------------------- metadata card

export function ResourceMetaCard({ resource, extra }: { resource: Resource; extra?: [React.ReactNode, React.ReactNode][] }) {
  return (
    <Card>
      <CardHeader><CardTitle>Details</CardTitle></CardHeader>
      <CardContent>
        <DefinitionList items={[
          ["Kind", KIND_LABELS[resource.kind] ?? resource.kind],
          ["Environment", resource.environment],
          ["Address", resource.address ? <span className="font-mono text-xs">{resource.address}</span> : ""],
          ["Location", resource.location],
          ["Owner", resource.business_owner],
          ["Open incidents", String(resource.open_incidents ?? 0)],
          ...(extra ?? []),
          ["Created", formatDateTime(resource.created_at)],
          ["Description", resource.description],
        ]} />
      </CardContent>
    </Card>
  );
}

/** Small inline error-prone helper used by detail pages. */
export function DetailState({ query, children }: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown; data: Resource | undefined };
  children: (r: Resource) => React.ReactNode;
}) {
  if (query.isLoading) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <InlineError error={new Error("Resource not found")} />;
  return <>{children(query.data)}</>;
}

