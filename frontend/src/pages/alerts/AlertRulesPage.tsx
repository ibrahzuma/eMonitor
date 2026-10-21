import { useQuery } from "@tanstack/react-query";
import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { alertsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader, RelativeTime, SeverityBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { SortTH, sortRows, Table, TBody, TD, TH, THead, TR, useSort } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { AlertRuleDialog } from "@/features/alerts/AlertRuleDialog";
import { describeCondition, RULE_TYPE_LABELS, ruleToPayload } from "@/features/alerts/AlertRuleForm";
import { useLiveInterval } from "@/features/realtime/RealtimeProvider";
import { useApiMutation } from "@/hooks/useApi";
import type { AlertRule } from "@/types/api";
import { SEVERITY_STYLES } from "@/utils/status";

const SEV_RANK: Record<string, number> = { critical: 3, high: 2, warning: 1, info: 0 };

export function AlertRulesPage() {
  const canManage = useCan("alerts:manage");
  const interval = useLiveInterval(60000, 30000);
  const rules = useQuery({ queryKey: qk.alertRules, queryFn: alertsApi.list, refetchInterval: interval });
  const [q, setQ] = React.useState("");
  const [editing, setEditing] = React.useState<AlertRule | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<AlertRule | null>(null);
  const { sort, onSort } = useSort<"name" | "rule_type" | "severity" | "firing" | "last_eval_at">({ key: "name", dir: "asc" });

  const toggle = useApiMutation({
    mutationFn: (r: AlertRule) => alertsApi.update(r.id, ruleToPayload(r, { enabled: !r.enabled })),
    invalidate: [qk.alertRules],
    success: (r) => (r.enabled ? `Enabled “${r.name}”` : `Disabled “${r.name}”`),
  });
  const remove = useApiMutation({
    mutationFn: (id: string) => alertsApi.remove(id),
    invalidate: [qk.alertRules],
    success: (m) => m.message,
    onSuccess: () => setDeleting(null),
  });

  const list = React.useMemo(() => {
    const items = (rules.data ?? []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()) || r.rule_type.includes(q.toLowerCase()));
    return sortRows(items, sort, (r, k) => {
      if (k === "severity") return SEV_RANK[r.severity] ?? 0;
      if (k === "firing") return r.firing;
      if (k === "last_eval_at") return r.last_eval_at ?? "";
      if (k === "rule_type") return RULE_TYPE_LABELS[r.rule_type] ?? r.rule_type;
      return r.name.toLowerCase();
    });
  }, [rules.data, q, sort]);

  const firingTotal = (rules.data ?? []).reduce((a, r) => a + r.firing, 0);

  return (
    <div>
      <PageHeader
        title="Alert Rules"
        description={rules.data ? `${rules.data.length} rules · ${firingTotal} firing subjects` : "Conditions evaluated against metrics, checks and logs"}
        actions={canManage && <Button onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus /> New rule</Button>}
      />
      <Card>
        <div className="flex items-center gap-2 border-b p-2">
          <Input aria-label="Filter rules" placeholder="Filter by name or type…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        </div>
        {rules.isLoading ? <LoadingState /> : rules.isError ? <ErrorState error={rules.error} onRetry={() => void rules.refetch()} /> : !list.length ? (
          <EmptyState icon={<BellRing />} title={q ? "No rules match the filter" : "No alert rules yet"}
            description="Rules turn telemetry into incidents: metric thresholds, response time, SSL expiry, log patterns and more."
            action={canManage && !q ? <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus /> Create the first rule</Button> : undefined} />
        ) : (
          <Table>
            <THead>
              <TR>
                <SortTH label="Name" sortKey="name" sort={sort} onSort={onSort} />
                <SortTH label="Type" sortKey="rule_type" sort={sort} onSort={onSort} />
                <TH>Condition</TH>
                <SortTH label="Severity" sortKey="severity" sort={sort} onSort={onSort} />
                <TH>Enabled</TH>
                <SortTH label="Firing" sortKey="firing" sort={sort} onSort={onSort} />
                <SortTH label="Last evaluated" sortKey="last_eval_at" sort={sort} onSort={onSort} />
                <TH>Last error</TH>
                {canManage && <TH className="text-right">Actions</TH>}
              </TR>
            </THead>
            <TBody>
              {list.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium"><Link to={`/alerts/${r.id}`} className="hover:underline">{r.name}</Link></TD>
                  <TD className="whitespace-nowrap text-xs">{RULE_TYPE_LABELS[r.rule_type] ?? r.rule_type}</TD>
                  <TD className="max-w-[280px] truncate text-xs text-muted-foreground" title={describeCondition(r.rule_type, r.condition)}>
                    {describeCondition(r.rule_type, r.condition)}
                  </TD>
                  <TD><SeverityBadge severity={r.severity} /></TD>
                  <TD>
                    <Switch checked={r.enabled} disabled={!canManage || toggle.isPending} aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.name}`}
                      onCheckedChange={() => toggle.mutate(r)} />
                  </TD>
                  <TD className="tabular">
                    {r.firing > 0 ? <Badge variant="destructive" style={{ color: SEVERITY_STYLES.critical.fill }}>{r.firing} firing</Badge> : <span className="text-muted-foreground">0</span>}
                  </TD>
                  <TD className="text-xs"><RelativeTime value={r.last_eval_at} /></TD>
                  <TD className="max-w-[220px] truncate text-xs text-destructive" title={r.last_error}>{r.last_error || <span className="text-muted-foreground">—</span>}</TD>
                  {canManage && (
                    <TD className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.name}`} onClick={() => { setEditing(r); setDialogOpen(true); }}><Pencil /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><Trash2 className="text-destructive" /></Button>
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <AlertRuleDialog open={dialogOpen} onOpenChange={setDialogOpen} rule={editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete rule “${deleting?.name ?? ""}”?`}
        description="Open incidents created by this rule remain until resolved." destructive confirmLabel="Delete rule"
        loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </div>
  );
}
