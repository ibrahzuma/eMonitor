import { Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { servicesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, NativeSelect } from "@/components/ui/input";
import { InlineError } from "@/components/ui/states";
import { CheckEditor } from "@/features/checks/CheckEditor";
import { type CheckDraft, defaultCheckDraft, draftToCheckIn, serverErrorsForCheck } from "@/features/checks/checkSpecs";
import { BaseResourceFields, type BaseFieldsState, baseFieldsFrom, baseFieldsPayload } from "@/features/resources/panels";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { CheckIn, ServiceCreate } from "@/types/api";
import { KIND_LABELS } from "@/utils/status";

export const SERVICE_KINDS = ["service", "database", "application", "api"] as const;
type ServiceKind = (typeof SERVICE_KINDS)[number];


export function AddServiceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [kind, setKind] = React.useState<ServiceKind>("service");
  const [base, setBase] = React.useState<BaseFieldsState>(() => baseFieldsFrom(null));
  const [checks, setChecks] = React.useState<CheckDraft[]>(() => [defaultCheckDraft("tcp")]);
  const [baseErrors, setBaseErrors] = React.useState<Record<string, string>>({});
  const [checkErrors, setCheckErrors] = React.useState<Record<string, string>[]>([{}]);
  const [formError, setFormError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      setKind("service");
      setBase(baseFieldsFrom(null));
      setChecks([defaultCheckDraft("tcp")]);
      setBaseErrors({});
      setCheckErrors([{}]);
      setFormError(null);
    }
  }, [open]);

  const create = useApiMutation({
    mutationFn: (p: ServiceCreate) => servicesApi.create(p),
    invalidate: [qk.resources, qk.dashboard],
    success: (r) => `“${r.name}” added`,
    errorTitle: false,
    onSuccess: (r) => {
      onOpenChange(false);
      navigate(`/services/${r.id}`);
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      setBaseErrors(Object.fromEntries(Object.entries(fe).filter(([k]) => !k.startsWith("checks."))));
      setCheckErrors(checks.map((_, i) => serverErrorsForCheck(fe, `checks.${i}.`)));
      setFormError(e);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const bErr: Record<string, string> = {};
    if (!base.name.trim()) bErr.name = "Name is required";
    const results = checks.map(draftToCheckIn);
    setBaseErrors(bErr);
    setCheckErrors(results.map((r) => r.errors));
    if (!checks.length) {
      setFormError(new Error("Add at least one check"));
      return;
    }
    if (Object.keys(bErr).length || results.some((r) => !r.payload)) return;
    create.mutate({
      ...baseFieldsPayload(base, { includeAddress: true }),
      kind,
      checks: results.map((r) => r.payload as CheckIn),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Add application or service</DialogTitle>
          <DialogDescription>Define the resource and one or more checks. Credentials are write-only and stored encrypted.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="flex flex-col gap-5">
            {formError !== null && <InlineError error={formError} />}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Kind" htmlFor="svc-kind">
                <NativeSelect id="svc-kind" value={kind} onChange={(e) => setKind(e.target.value as ServiceKind)}>
                  {SERVICE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </NativeSelect>
              </Field>
            </div>
            <BaseResourceFields value={base} onChange={setBase} errors={baseErrors} idPrefix="svc" showAddress />
            {checks.map((c, i) => (
              <section key={i} aria-label={`Check ${i + 1}`} className="rounded-md border p-3">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Check {i + 1}</h3>
                  {checks.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => {
                      setChecks(checks.filter((_, j) => j !== i));
                      setCheckErrors(checkErrors.filter((_, j) => j !== i));
                    }}><Trash2 /> Remove check</Button>
                  )}
                </div>
                <CheckEditor value={c} idPrefix={`svc-chk${i}`} errors={checkErrors[i] ?? {}}
                  onChange={(d) => setChecks(checks.map((x, j) => (j === i ? d : x)))} />
              </section>
            ))}
            <div>
              <Button variant="outline" onClick={() => {
                if (checks.length >= 20) return;
                setChecks([...checks, defaultCheckDraft("tcp")]);
                setCheckErrors([...checkErrors, {}]);
              }} disabled={checks.length >= 20}><Plus /> Add another check</Button>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
