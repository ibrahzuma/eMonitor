import * as React from "react";
import { alertsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertRuleForm } from "@/features/alerts/AlertRuleForm";
import { useApiMutation } from "@/hooks/useApi";
import type { AlertRule, AlertRuleIn } from "@/types/api";

/** Create / edit dialog shared by the list and detail pages. */
export function AlertRuleDialog({ open, onOpenChange, rule, onSaved }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rule: AlertRule | null;
  onSaved?: (r: AlertRule) => void;
}) {
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (open) setSubmitError(null);
  }, [open]);
  const save = useApiMutation({
    mutationFn: (body: AlertRuleIn) => (rule ? alertsApi.update(rule.id, body) : alertsApi.create(body)),
    invalidate: [qk.alertRules],
    success: rule ? "Alert rule updated" : "Alert rule created",
    errorTitle: "Could not save alert rule",
    onSuccess: (r) => {
      onOpenChange(false);
      onSaved?.(r);
    },
    onError: (e) => setSubmitError(e),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{rule ? `Edit rule “${rule.name}”` : "New alert rule"}</DialogTitle></DialogHeader>
        <DialogBody>
          <AlertRuleForm rule={rule} submitting={save.isPending} error={submitError} onCancel={() => onOpenChange(false)}
            onSubmit={(p) => { setSubmitError(null); save.mutate(p); }} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
