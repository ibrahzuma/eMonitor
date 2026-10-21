import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FlaskConical, Pencil, Trash2 } from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { alertsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { DefinitionList, JsonView, RelativeTime, SeverityBadge, StatusBadge } from "@/components/common";
import { useGroups, usePolicies } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { describeCondition, RULE_TYPE_LABELS } from "@/features/alerts/AlertRuleForm";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useApiMutation } from "@/hooks/useApi";
import { AlertRuleDialog } from "@/features/alerts/AlertRuleDialog";
import type { AlertRule, RulePreviewRow } from "@/types/api";
import { formatDuration, formatNumber, humanize } from "@/utils/format";
import { KIND_LABELS } from "@/utils/status";

function TargetSummary({ rule }: { rule: AlertRule }) {
  const groups = useGroups();
  const t = rule.target;
  const groupNames = new Map((groups.data ?? []).map((g) => [g.id, g.name] as const));
  const parts: [string, React.ReactNode][] = [];
  if (t.resource_ids?.length) parts.push(["Resources", `${t.resource_ids.length} selected`]);
  if (t.group_ids?.length) parts.push(["Groups", t.group_ids.map((g) => groupNames.get(g) ?? g.slice(0, 8)).join(", ")]);
  if (t.check_ids?.length) parts.push(["Checks", `${t.check_ids.length} selected`]);
  if (t.tags?.length) parts.push(["Tags", <span key="t" className="flex flex-wrap gap-1">{t.tags.map((x) => <Badge key={x}>{x}</Badge>)}</span>]);
  if (t.kinds?.length) parts.push(["Kinds", t.kinds.map((k) => KIND_LABELS[k] ?? k).join(", ")]);
  if (t.environments?.length) parts.push(["Environments", t.environments.map(humanize).join(", ")]);
  if (!parts.length) return <p className="text-sm text-muted-foreground">All applicable resources in the organization.</p>;
  return <DefinitionList items={parts} />;
}

export function AlertRuleDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const canManage = useCan("alerts:manage");
  const interval = useLiveInterval(60000, 30000);
  const rule = useQuery({ queryKey: qk.alertRule(id), queryFn: () => alertsApi.get(id), refetchInterval: interval });
  const states = useQuery({ queryKey: qk.alertRuleStates(id), queryFn: () => alertsApi.states(id), refetchInterval: interval });
  const policies = usePolicies();
  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [preview, setPreview] = React.useState<RulePreviewRow[] | null>(null);

  const runPreview = useApiMutation({
    mutationFn: () => alertsApi.preview(id),
    errorTitle: "Preview failed",
    onSuccess: (rows) => setPreview(rows),
  });
  const remove = useApiMutation({
    mutationFn: () => alertsApi.remove(id),
    invalidate: [qk.alertRules],
    success: (m) => m.message,
    onSuccess: () => navigate("/alerts"),
  });

  if (rule.isLoading) return <LoadingState />;
  if (rule.isError) return <ErrorState error={rule.error} onRetry={() => void rule.refetch()} />;
  const r = rule.data;
  if (!r) return <InlineError error={new Error("Alert rule not found")} />;
  const policyName = r.notification_policy_id ? (policies.data ?? []).find((p) => p.id === r.notification_policy_id)?.name ?? r.notification_policy_id : "Default routing";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link to="/alerts" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Alert rules
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight">{r.name}</h1>
              <SeverityBadge severity={r.severity} />
              <Badge variant={r.enabled ? "success" : "outline"}>{r.enabled ? "Enabled" : "Disabled"}</Badge>
              {r.firing > 0 && <Badge variant="destructive">{r.firing} firing</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{RULE_TYPE_LABELS[r.rule_type]} · {describeCondition(r.rule_type, r.condition)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => runPreview.mutate()} loading={runPreview.isPending}><FlaskConical /> Preview</Button>
            {canManage && <Button variant="outline" onClick={() => setEditOpen(true)}><Pencil /> Edit</Button>}
            {canManage && <Button variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</Button>}
          </div>
        </div>
      </div>

      {r.last_error && <InlineError error={new Error(`Last evaluation error: ${r.last_error}`)} />}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Preview — evaluated now ({preview.length} subjects)</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Close</Button>
          </CardHeader>
          {!preview.length ? (
            <EmptyState title="No subjects matched" description="The targets did not resolve to any resource or check with data." />
          ) : (
            <Table>
              <THead><TR><TH>Subject</TH><TH>Resource</TH><TH>Result</TH><TH>Value</TH><TH>Detail</TH></TR></THead>
              <TBody>
                {preview.map((p) => (
                  <TR key={p.subject}>
                    <TD className="font-mono text-xs">{p.subject}</TD>
                    <TD>{p.resource ?? "—"}</TD>
                    <TD>{p.breached ? <StatusBadge status="firing" /> : <StatusBadge status="ok" />}</TD>
                    <TD className="tabular">{formatNumber(p.value, 3)}</TD>
                    <TD className="text-xs text-muted-foreground">{p.detail}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <DefinitionList items={[
              ["Type", RULE_TYPE_LABELS[r.rule_type]],
              ["Evaluated every", formatDuration(r.evaluation_interval_seconds)],
              ["Fires after", `${r.consecutive_breaches} consecutive breach(es)`],
              ["Recovers after", `${r.recovery_consecutive} OK evaluation(s)`],
              ["Cooldown", formatDuration(r.cooldown_seconds)],
              ["Maintenance", r.suppress_in_maintenance ? "Suppressed" : "Not suppressed"],
              ["Auto-resolve", r.auto_resolve ? "Yes" : "No"],
              ["Notification policy", policyName],
              ["Last evaluated", <RelativeTime key="le" value={r.last_eval_at} />],
              ["Description", r.description],
            ]} />
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Condition</p>
              <JsonView value={r.condition} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Targets</CardTitle></CardHeader>
          <CardContent><TargetSummary rule={r} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Evaluation state per subject</CardTitle></CardHeader>
        {states.isLoading ? <LoadingState /> : states.isError ? <ErrorState error={states.error} onRetry={() => void states.refetch()} /> : !states.data?.length ? (
          <EmptyState title="No evaluation state yet" description="State is recorded per resource/check once the rule has been evaluated." />
        ) : (
          <Table>
            <THead><TR><TH>Subject</TH><TH>State</TH><TH>Breaches</TH><TH>OKs</TH><TH>Last value</TH><TH>Last fired</TH><TH>Last resolved</TH><TH>Updated</TH></TR></THead>
            <TBody>
              {states.data.map((s) => (
                <TR key={s.subject_key}>
                  <TD className="font-mono text-xs">{s.subject_key}</TD>
                  <TD><StatusBadge status={s.state} /></TD>
                  <TD className="tabular">{s.breaches}</TD>
                  <TD className="tabular">{s.oks}</TD>
                  <TD className="tabular">{formatNumber(s.last_value, 3)}</TD>
                  <TD className="text-xs"><RelativeTime value={s.last_fired_at} /></TD>
                  <TD className="text-xs"><RelativeTime value={s.last_resolved_at} /></TD>
                  <TD className="text-xs"><RelativeTime value={s.updated_at} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <AlertRuleDialog open={editOpen} onOpenChange={setEditOpen} rule={r} />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete rule “${r.name}”?`} destructive confirmLabel="Delete rule"
        description="Open incidents created by this rule remain until resolved." loading={remove.isPending} onConfirm={() => remove.mutate()} />
    </div>
  );
}
