import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Square, Trash2 } from "lucide-react";
import * as React from "react";
import { maintenanceApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader } from "@/components/common";
import { GroupPicker, MemberSelect, ResourcePicker, useGroups, useMembers } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField, Switch } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { MaintenanceWindow } from "@/types/api";
import { formatDateTime, formatRelative, listTimeZones } from "@/utils/format";
import {
  emptyWindowForm,
  recurrenceSummary,
  type RecurrenceEnd,
  type RecurrenceFreq,
  type WindowForm,
  windowPayload,
  windowToForm,
} from "@/pages/maintenance/windowPayload";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function WindowDialog({ open, onOpenChange, window: w }: { open: boolean; onOpenChange: (o: boolean) => void; window: MaintenanceWindow | null }) {
  const [f, setF] = React.useState<WindowForm>(() => (w ? windowToForm(w) : emptyWindowForm()));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const zones = React.useMemo(listTimeZones, []);
  React.useEffect(() => {
    if (open) { setF(w ? windowToForm(w) : emptyWindowForm()); setErrors({}); }
  }, [open, w]);
  const set = <K extends keyof WindowForm>(k: K, v: WindowForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const save = useApiMutation({
    mutationFn: async () => {
      const { payload, errors: errs } = windowPayload(f);
      setErrors(errs);
      if (!payload) throw new Error("Please fix the highlighted fields");
      return w ? maintenanceApi.update(w.id, payload) : maintenanceApi.create(payload);
    },
    invalidate: [qk.maintenance, qk.resources, qk.dashboard],
    success: w ? "Maintenance window updated" : "Maintenance window scheduled",
    errorTitle: "Could not save maintenance window",
    onSuccess: () => onOpenChange(false),
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{w ? `Edit “${w.name}”` : "Schedule maintenance"}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="mw-name" error={errors.name} required className="sm:col-span-2">
                <Input id="mw-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Reason" htmlFor="mw-reason" className="sm:col-span-2">
                <Textarea id="mw-reason" rows={2} value={f.reason} onChange={(e) => set("reason", e.target.value)} />
              </Field>
              <Field label="Starts" htmlFor="mw-start" error={errors.starts_at} required>
                <Input id="mw-start" type="datetime-local" value={f.starts_local} onChange={(e) => set("starts_local", e.target.value)} />
              </Field>
              <Field label="Ends" htmlFor="mw-end" error={errors.ends_at} required>
                <Input id="mw-end" type="datetime-local" value={f.ends_local} onChange={(e) => set("ends_local", e.target.value)} />
              </Field>
              <Field label="Time zone" htmlFor="mw-tz" hint="Start/end are wall-clock times in this zone">
                <NativeSelect id="mw-tz" value={f.timezone} onChange={(e) => set("timezone", e.target.value)}>
                  {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Responsible user" htmlFor="mw-user" hint="Defaults to you">
                <MemberSelect id="mw-user" value={f.responsible_user_id} onChange={(v) => set("responsible_user_id", v)} emptyLabel="— Me —" />
              </Field>
            </div>
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Recurrence</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Repeat" htmlFor="mw-freq">
                  <NativeSelect id="mw-freq" value={f.freq} onChange={(e) => set("freq", e.target.value as RecurrenceFreq)}>
                    <option value="none">Does not repeat</option><option value="daily">Daily</option>
                    <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                  </NativeSelect>
                </Field>
                {f.freq !== "none" && (
                  <>
                    <Field label="Every (interval)" htmlFor="mw-interval" error={errors.interval}>
                      <Input id="mw-interval" type="number" min={1} max={52} value={f.interval} onChange={(e) => set("interval", e.target.value)} />
                    </Field>
                    <Field label="Ends" htmlFor="mw-endmode">
                      <NativeSelect id="mw-endmode" value={f.end_mode} onChange={(e) => set("end_mode", e.target.value as RecurrenceEnd)}>
                        <option value="never">Never</option><option value="until">On date</option><option value="count">After N occurrences</option>
                      </NativeSelect>
                    </Field>
                    {f.freq === "weekly" && (
                      <div className="flex flex-wrap gap-3 sm:col-span-3" role="group" aria-label="Weekdays">
                        {DAYS.map((d, i) => (
                          <CheckboxField key={d} id={`mw-wd-${i}`} label={d} checked={f.byweekday.includes(i)}
                            onCheckedChange={(v) => set("byweekday", v ? [...f.byweekday, i] : f.byweekday.filter((x) => x !== i))} />
                        ))}
                      </div>
                    )}
                    {f.end_mode === "until" && (
                      <Field label="Until" htmlFor="mw-until" error={errors.until}>
                        <Input id="mw-until" type="datetime-local" value={f.until_local} onChange={(e) => set("until_local", e.target.value)} />
                      </Field>
                    )}
                    {f.end_mode === "count" && (
                      <Field label="Occurrences" htmlFor="mw-count" error={errors.count}>
                        <Input id="mw-count" type="number" min={1} max={1000} value={f.count} onChange={(e) => set("count", e.target.value)} />
                      </Field>
                    )}
                  </>
                )}
              </div>
            </fieldset>
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Scope</legend>
              <div className="flex flex-col gap-3">
                <Field label="Applies to" htmlFor="mw-scope">
                  <NativeSelect id="mw-scope" value={f.scope} onChange={(e) => set("scope", e.target.value as WindowForm["scope"])}>
                    <option value="resources">Selected resources</option><option value="groups">Resource groups</option><option value="organization">Entire organization</option>
                  </NativeSelect>
                </Field>
                {f.scope === "resources" && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Resources</span>
                    <ResourcePicker id="mw-res" ariaLabel="Resources" value={f.resource_ids} onChange={(v) => set("resource_ids", v)} />
                    {errors.resource_ids && <p role="alert" className="text-xs text-destructive">{errors.resource_ids}</p>}
                  </div>
                )}
                {f.scope === "groups" && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Groups</span>
                    <GroupPicker id="mw-groups" value={f.group_ids} onChange={(v) => set("group_ids", v)} />
                    {errors.group_ids && <p role="alert" className="text-xs text-destructive">{errors.group_ids}</p>}
                  </div>
                )}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-4">
              <CheckboxField id="mw-sn" label="Suppress notifications" checked={f.suppress_notifications} onCheckedChange={(v) => set("suppress_notifications", v)} />
              <CheckboxField id="mw-si" label="Suppress incidents" hint="No incidents are created during the window" checked={f.suppress_incidents}
                onCheckedChange={(v) => set("suppress_incidents", v)} />
              <CheckboxField id="mw-active" label="Active" checked={f.is_active} onCheckedChange={(v) => set("is_active", v)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{w ? "Save" : "Schedule"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MaintenancePage() {
  const canManage = useCan("maintenance:manage");
  const [includeExpired, setIncludeExpired] = React.useState(false);
  const interval = useLiveInterval(60000, 30000);
  const q = useQuery({
    queryKey: [...qk.maintenance, { includeExpired }],
    queryFn: () => maintenanceApi.list(includeExpired),
    refetchInterval: interval,
  });
  const groups = useGroups();
  const members = useMembers();
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name] as const));
  const userName = new Map((members.data?.items ?? []).map((m) => [m.user_id, m.full_name || m.email] as const));
  const [editing, setEditing] = React.useState<MaintenanceWindow | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<MaintenanceWindow | null>(null);
  const [ending, setEnding] = React.useState<MaintenanceWindow | null>(null);
  const inv = [qk.maintenance, qk.resources, qk.dashboard];
  const end = useApiMutation({ mutationFn: (id: string) => maintenanceApi.end(id), success: "Maintenance ended", invalidate: inv, onSuccess: () => setEnding(null) });
  const remove = useApiMutation({ mutationFn: (id: string) => maintenanceApi.remove(id), success: "Maintenance window deleted", invalidate: inv, onSuccess: () => setDeleting(null) });

  const scopeSummary = (w: MaintenanceWindow) => {
    if (w.scope === "organization") return "Entire organization";
    if (w.scope === "groups") return `Groups: ${w.group_ids.map((g) => groupName.get(g) ?? g.slice(0, 8)).join(", ")}`;
    return `${w.resource_ids.length} resource${w.resource_ids.length === 1 ? "" : "s"}`;
  };

  return (
    <div>
      <PageHeader title="Maintenance windows" description="Planned work suppresses notifications (and optionally incidents) for the affected scope."
        actions={canManage && <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus /> Schedule maintenance</Button>} />
      <Card>
        <CardHeader>
          <CardTitle>Windows</CardTitle>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={includeExpired} onCheckedChange={setIncludeExpired} aria-label="Include expired windows" /> Include expired
          </label>
        </CardHeader>
        {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
          <EmptyState title="No maintenance windows" description="Schedule a window before planned work to avoid alert noise." />
        ) : (
          <Table>
            <THead><TR><TH>Name</TH><TH>Status</TH><TH>Scope</TH><TH>Occurrence</TH><TH>Recurrence</TH><TH>Suppresses</TH><TH>Responsible</TH><TH className="text-right">Actions</TH></TR></THead>
            <TBody>
              {q.data.map((w) => {
                const occ = w.current_occurrence ?? w.next_occurrence;
                return (
                  <TR key={w.id}>
                    <TD className="font-medium">{w.name}{w.reason && <p className="max-w-xs truncate text-xs font-normal text-muted-foreground" title={w.reason}>{w.reason}</p>}</TD>
                    <TD>
                      {w.active_now ? <Badge variant="info">Active now</Badge> : !w.is_active ? <Badge variant="outline">Ended</Badge>
                        : w.expired ? <Badge variant="outline">Expired</Badge> : <Badge variant="secondary">Scheduled</Badge>}
                    </TD>
                    <TD className="text-xs">{scopeSummary(w)}</TD>
                    <TD className="whitespace-nowrap text-xs">
                      {occ ? (
                        <>
                          <span className="text-muted-foreground">{w.current_occurrence ? "Now: " : "Next: "}</span>
                          {formatDateTime(occ.start)} → {formatDateTime(occ.end)}
                          {!w.current_occurrence && <span className="block text-muted-foreground">{formatRelative(occ.start)}</span>}
                        </>
                      ) : "—"}
                    </TD>
                    <TD className="text-xs">{recurrenceSummary(w.recurrence)}{w.recurrence?.until && <span className="block text-muted-foreground">until {formatDateTime(w.recurrence.until)}</span>}
                      <span className="block text-muted-foreground">{w.timezone}</span></TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {w.suppress_notifications && <Badge variant="outline">notifications</Badge>}
                        {w.suppress_incidents && <Badge variant="outline">incidents</Badge>}
                      </div>
                    </TD>
                    <TD className="text-xs">{w.responsible_user_id ? userName.get(w.responsible_user_id) ?? "—" : "—"}</TD>
                    <TD className="text-right">
                      {canManage && (
                        <div className="flex justify-end gap-1">
                          {w.active_now && <Button variant="outline" size="sm" onClick={() => setEnding(w)}><Square /> End early</Button>}
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${w.name}`} onClick={() => { setEditing(w); setOpen(true); }}><Pencil /></Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${w.name}`} onClick={() => setDeleting(w)}><Trash2 className="text-destructive" /></Button>
                        </div>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      <WindowDialog open={open} onOpenChange={setOpen} window={editing} />
      <ConfirmDialog open={Boolean(ending)} onOpenChange={(o) => !o && setEnding(null)} title={`End “${ending?.name ?? ""}” now?`}
        description="The window is deactivated immediately and monitoring resumes normally." confirmLabel="End maintenance"
        loading={end.isPending} onConfirm={() => ending && end.mutate(ending.id)} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete “${deleting?.name ?? ""}”?`}
        destructive confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </div>
  );
}
