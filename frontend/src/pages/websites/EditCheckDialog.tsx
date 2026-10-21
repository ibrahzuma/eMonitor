import * as React from "react";
import { checksApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckEditor } from "@/features/checks/CheckEditor";
import { type CheckDraft, checkToDraft, draftToCheckIn, serverErrorsForCheck } from "@/features/checks/checkSpecs";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { Check } from "@/types/api";

export function EditCheckDialog({ check, open, onOpenChange }: { check: Check; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [draft, setDraft] = React.useState<CheckDraft>(() => checkToDraft(check));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setDraft(checkToDraft(check));
      setErrors({});
    }
  }, [open, check]);
  const save = useApiMutation({
    mutationFn: (d: CheckDraft) => {
      const { payload, errors: errs } = draftToCheckIn(d);
      if (!payload) {
        setErrors(errs);
        return Promise.reject(new Error("Please fix the highlighted fields"));
      }
      const { type: _type, ...rest } = payload;
      return checksApi.update(check.id, rest);
    },
    success: "Check updated",
    errorTitle: "Could not save check",
    invalidate: [qk.resources, qk.checks],
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      if (Object.keys(fe).length) setErrors((p) => ({ ...p, ...serverErrorsForCheck(fe) }));
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>Edit {check.name} check</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
          <DialogBody>
            <CheckEditor value={draft} onChange={setDraft} errors={errors} idPrefix="edit-http" lockType hasSecrets={check.has_secrets} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save check</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
