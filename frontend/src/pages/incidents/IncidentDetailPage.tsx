import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BellRing,
  CheckCircle2,
  Eye,
  MessageSquare,
  Pencil,
  RotateCcw,
  Search,
  TriangleAlert,
  UserPlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { incidentsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { DefinitionList, IncidentStatusBadge, JsonView, RelativeTime, SeverityBadge, StatusBadge } from "@/components/common";
import { MemberSelect } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useApiMutation } from "@/hooks/useApi";
import { type IncidentDetail, SEVERITIES, type Severity } from "@/types/api";
import { formatDateTime, formatDuration, humanize, toDate } from "@/utils/format";
import { isOpenIncident, resourcePath } from "@/utils/status";

const EVENT_ICONS: Record<string, LucideIcon> = {
  triggered: TriangleAlert,
  reopened: RotateCcw,
  acknowledged: Eye,
  investigating: Search,
  assigned: UserPlus,
  comment: MessageSquare,
  resolved: CheckCircle2,
  recovered: CheckCircle2,
  updated: Pencil,
  escalated: BellRing,
  notification: BellRing,
  maintenance: Wrench,
};

/** Re-render every second while an incident is open so the duration ticks. */
function useLiveDuration(inc: IncidentDetail | undefined): number {
  const [now, setNow] = React.useState(() => Date.now());
  const open = inc ? isOpenIncident(inc.status) : false;
  React.useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open]);
  if (!inc) return 0;
  const start = toDate(inc.first_detected_at)?.getTime() ?? now;
  const end = inc.resolved_at ? toDate(inc.resolved_at)?.getTime() ?? now : now;
  return open ? Math.max(0, (now - start) / 1000) : Math.max(inc.duration_seconds, (end - start) / 1000);
}

function TextDialog({ open, onOpenChange, title, label, required, confirmLabel, loading, onConfirm, placeholder }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  label: string;
  required?: boolean;
  confirmLabel: string;
  loading: boolean;
  onConfirm: (text: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setText("");
      setError(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => {
          e.preventDefault();
          if (required && !text.trim()) {
            setError(`${label} is required`);
            return;
          }
          onConfirm(text.trim());
        }}>
          <DialogBody>
            <Field label={label} htmlFor="incident-dialog-text" error={error} required={required}>
              <Textarea id="incident-dialog-text" rows={4} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={loading}>{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function IncidentDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const canOperate = useCan("incidents:operate");
  const interval = useLiveInterval(60000, 30000);
  const q = useQuery({ queryKey: qk.incident(id), queryFn: () => incidentsApi.get(id), refetchInterval: interval });
  const inc = q.data;
  const duration = useLiveDuration(inc);

  const [dialog, setDialog] = React.useState<null | "resolve" | "assign" | "edit" | "reopen">(null);
  const [assignee, setAssignee] = React.useState("");
  const [edit, setEdit] = React.useState<{ title: string; severity: Severity; description: string }>({ title: "", severity: "warning", description: "" });
  const [editError, setEditError] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");

  const onDone = (data: IncidentDetail) => {
    qc.setQueryData(qk.incident(id), data);
    setDialog(null);
  };
  const opts = <V,>(fn: (v: V) => Promise<IncidentDetail>, success: string) => ({
    mutationFn: fn,
    success,
    invalidate: [qk.incidents, qk.dashboard],
    errorTitle: "Action failed",
    onSuccess: onDone,
  });
  const ack = useApiMutation(opts<void>(() => incidentsApi.acknowledge(id), "Incident acknowledged"));
  const investigate = useApiMutation(opts<void>(() => incidentsApi.investigate(id), "Marked as investigating"));
  const resolve = useApiMutation(opts((resolution: string) => incidentsApi.resolve(id, resolution), "Incident resolved"));
  const reopen = useApiMutation(opts((note: string) => incidentsApi.reopen(id, note), "Incident reopened"));
  const assign = useApiMutation(opts((uid: string) => incidentsApi.assign(id, uid || null), "Assignment updated"));
  const update = useApiMutation(opts((body: { title: string; severity: Severity; description: string }) => incidentsApi.update(id, body),
    "Incident updated"));
  const addComment = useApiMutation({
    mutationFn: (note: string) => incidentsApi.comment(id, note),
    success: "Comment added",
    invalidate: [qk.incidents],
    onSuccess: (data) => {
      qc.setQueryData(qk.incident(id), data);
      setComment("");
    },
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!inc) return <InlineError error={new Error("Incident not found")} />;

  const open = isOpenIncident(inc.status);
  const resolved = inc.status === "resolved";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link to="/incidents" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Incidents
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">INC-{inc.number}</span>
              <h1 className="text-lg font-semibold tracking-tight">{inc.title}</h1>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <SeverityBadge severity={inc.severity} />
              <IncidentStatusBadge status={inc.status} />
              {inc.in_maintenance && <Badge variant="info">In maintenance</Badge>}
              <span className="tabular" aria-label="Duration">{open ? "Open for" : "Lasted"} {formatDuration(duration)}</span>
              {inc.resource_id && (
                <span>on <Link className="text-foreground hover:underline" to={resourcePath(inc.resource_kind, inc.resource_id)}>{inc.resource_name ?? "resource"}</Link></span>
              )}
              <span>· {inc.assignee_name ? `Assigned to ${inc.assignee_name}` : "Unassigned"}</span>
            </div>
          </div>
          {canOperate && (
            <div className="flex flex-wrap gap-2">
              {(inc.status === "triggered" || inc.status === "reopened") && (
                <Button onClick={() => ack.mutate()} loading={ack.isPending}><Eye /> Acknowledge</Button>
              )}
              {!resolved && inc.status !== "investigating" && (
                <Button variant="outline" onClick={() => investigate.mutate()} loading={investigate.isPending}><Search /> Investigate</Button>
              )}
              <Button variant="outline" onClick={() => { setAssignee(inc.assignee_id ?? ""); setDialog("assign"); }}><UserPlus /> Assign</Button>
              {!resolved && <Button variant="outline" onClick={() => setDialog("resolve")}><CheckCircle2 /> Resolve</Button>}
              {resolved && <Button variant="outline" onClick={() => setDialog("reopen")}><RotateCcw /> Reopen</Button>}
              <Button variant="ghost" onClick={() => {
                setEdit({ title: inc.title, severity: inc.severity, description: inc.description });
                setEditError(null);
                setDialog("edit");
              }}><Pencil /> Edit</Button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="flex flex-col gap-4 xl:col-span-2">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <DefinitionList items={[
                ["Trigger condition", inc.trigger_condition],
                ["Source", humanize(inc.source)],
                ["First detected", formatDateTime(inc.first_detected_at, { seconds: true })],
                ["Last detected", formatDateTime(inc.last_detected_at, { seconds: true })],
                ["Acknowledged", inc.acknowledged_at ? formatDateTime(inc.acknowledged_at, { seconds: true }) : ""],
                ["Resolved", inc.resolved_at ? formatDateTime(inc.resolved_at, { seconds: true }) : ""],
                ["Resolution", inc.resolution],
                ["Occurrences", String(inc.occurrence_count)],
                ["Reopened", `${inc.reopen_count} time${inc.reopen_count === 1 ? "" : "s"}`],
                ["Escalation step", String(inc.escalation_step)],
                ["Alert rule", inc.alert_rule_id ? <Link key="r" className="hover:underline" to={`/alerts/${inc.alert_rule_id}`}>View rule</Link> : ""],
                ["Description", inc.description ? <p key="d" className="whitespace-pre-wrap">{inc.description}</p> : ""],
              ]} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-4">
              {!inc.timeline.length ? <p className="text-sm text-muted-foreground">No events recorded.</p> : (
                <ol className="relative flex flex-col gap-3 border-l pl-5" aria-label="Incident timeline">
                  {inc.timeline.map((ev) => {
                    const Icon = EVENT_ICONS[ev.kind] ?? BellRing;
                    return (
                      <li key={ev.id} className="relative">
                        <span className="absolute -left-[29px] top-0.5 flex size-5 items-center justify-center rounded-full border bg-card">
                          <Icon className="size-3 text-muted-foreground" aria-hidden />
                        </span>
                        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                          <span className="font-medium">{ev.actor_name ?? "System"}</span>
                          <span className="text-xs text-muted-foreground">{humanize(ev.kind)}</span>
                          <span className="text-xs text-muted-foreground"><RelativeTime value={ev.created_at} /></span>
                        </div>
                        {ev.message && (
                          <p className={ev.kind === "comment" ? "mt-1 whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm" : "text-sm text-muted-foreground"}>
                            {ev.message}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
              {canOperate && (
                <form className="flex flex-col gap-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) addComment.mutate(comment.trim()); }}>
                  <label htmlFor="incident-comment" className="text-xs font-medium">Add comment</label>
                  <Textarea id="incident-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Share findings, next steps…" />
                  <div><Button type="submit" size="sm" disabled={!comment.trim()} loading={addComment.isPending}><MessageSquare /> Comment</Button></div>
                </form>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle>Evidence</CardTitle></CardHeader>
            <CardContent>
              {Object.keys(inc.evidence ?? {}).length ? <JsonView value={inc.evidence} /> : <p className="text-sm text-muted-foreground">No evidence attached.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Notifications ({inc.deliveries.length})</CardTitle></CardHeader>
            {!inc.deliveries.length ? <EmptyState title="No notifications sent" className="py-6" /> : (
              <Table>
                <THead><TR><TH>Channel</TH><TH>Event</TH><TH>Status</TH><TH>When</TH></TR></THead>
                <TBody>
                  {inc.deliveries.map((d) => (
                    <TR key={d.id}>
                      <TD className="text-xs">{humanize(d.channel_type)}</TD>
                      <TD className="text-xs">{humanize(d.event)}</TD>
                      <TD>
                        <StatusBadge status={d.status} />
                        {(d.last_error || d.status_reason) && <p className="mt-0.5 max-w-[180px] truncate text-[11px] text-muted-foreground" title={d.last_error || d.status_reason}>{d.last_error || d.status_reason}</p>}
                      </TD>
                      <TD className="text-xs"><RelativeTime value={d.sent_at ?? d.created_at} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader><CardTitle>Related incidents</CardTitle></CardHeader>
            {!inc.related.length ? <EmptyState title="No related incidents" className="py-6" /> : (
              <ul className="divide-y">
                {inc.related.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                    <Link to={`/incidents/${r.id}`} className="min-w-0 flex-1 truncate hover:underline">
                      <span className="font-mono text-xs text-muted-foreground">INC-{r.number}</span> {r.title}
                    </Link>
                    <IncidentStatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <TextDialog open={dialog === "resolve"} onOpenChange={(o) => setDialog(o ? "resolve" : null)} title={`Resolve INC-${inc.number}`}
        label="Resolution" required confirmLabel="Resolve incident" loading={resolve.isPending} placeholder="What fixed it?"
        onConfirm={(t) => resolve.mutate(t)} />
      <TextDialog open={dialog === "reopen"} onOpenChange={(o) => setDialog(o ? "reopen" : null)} title={`Reopen INC-${inc.number}`}
        label="Note" confirmLabel="Reopen incident" loading={reopen.isPending} onConfirm={(t) => reopen.mutate(t)} />

      <Dialog open={dialog === "assign"} onOpenChange={(o) => setDialog(o ? "assign" : null)}>
        <DialogContent size="sm">
          <DialogHeader><DialogTitle>Assign INC-{inc.number}</DialogTitle></DialogHeader>
          <form className="contents" onSubmit={(e) => { e.preventDefault(); assign.mutate(assignee); }}>
            <DialogBody>
              <Field label="Assignee" htmlFor="incident-assignee">
                <MemberSelect id="incident-assignee" value={assignee} onChange={setAssignee} />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
              <Button type="submit" loading={assign.isPending}>{assignee ? "Assign" : "Unassign"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "edit"} onOpenChange={(o) => setDialog(o ? "edit" : null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit INC-{inc.number}</DialogTitle></DialogHeader>
          <form className="contents" noValidate onSubmit={(e) => {
            e.preventDefault();
            if (edit.title.trim().length < 3) {
              setEditError("Title must be at least 3 characters");
              return;
            }
            update.mutate({ ...edit, title: edit.title.trim() });
          }}>
            <DialogBody className="flex flex-col gap-3">
              <Field label="Title" htmlFor="incident-edit-title" error={editError} required>
                <Input id="incident-edit-title" value={edit.title} maxLength={300} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              </Field>
              <Field label="Severity" htmlFor="incident-edit-sev">
                <NativeSelect id="incident-edit-sev" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value as Severity })}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Description" htmlFor="incident-edit-desc">
                <Textarea id="incident-edit-desc" rows={4} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
              <Button type="submit" loading={update.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
