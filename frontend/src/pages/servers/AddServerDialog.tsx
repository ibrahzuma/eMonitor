import * as React from "react";
import { serversApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { TagInput } from "@/components/common";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { InlineError } from "@/components/ui/states";
import { BaseResourceFields, type BaseFieldsState, baseFieldsFrom, baseFieldsPayload } from "@/features/resources/panels";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { Resource, ServerCreate } from "@/types/api";
import {
  ServerFields,
  type ServerFieldsDraft,
  type ThresholdDraft,
  ThresholdsEditor,
  draftToThresholds,
  parseServerNumbers,
  thresholdsToDraft,
} from "@/pages/servers/serverForm";

const emptyServerFields = (): ServerFieldsDraft => ({
  hostname: "", ip_address: "", os_family: "linux", os_version: "", monitoring_interval_seconds: "30", agent_timeout_seconds: "",
});

/** Build and validate the POST /servers payload. */
export function buildServerPayload(base: BaseFieldsState, srv: ServerFieldsDraft, services: string[], pingCheck: boolean,
  thresholds: ThresholdDraft): { payload: ServerCreate | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!base.name.trim()) errors.name = "Name is required";
  if (pingCheck && !srv.hostname.trim() && !srv.ip_address.trim()) {
    errors.hostname = "Hostname or IP address is required for a ping check";
  }
  const { interval, timeout } = parseServerNumbers(srv, errors);
  for (const s of services) if (!/^[A-Za-z0-9@._-]{1,128}$/.test(s)) errors.monitored_services = `Invalid service name "${s}"`;
  const th = draftToThresholds(thresholds, errors);
  if (Object.keys(errors).length) return { payload: null, errors };
  return {
    errors,
    payload: {
      ...baseFieldsPayload(base),
      hostname: srv.hostname.trim(),
      ip_address: srv.ip_address.trim(),
      os_family: srv.os_family,
      os_version: srv.os_version.trim(),
      monitoring_interval_seconds: interval,
      agent_timeout_seconds: timeout,
      monitored_services: services,
      thresholds: th,
      ping_check: pingCheck,
    },
  };
}

export function AddServerDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (r: Resource) => void;
}) {
  const [base, setBase] = React.useState<BaseFieldsState>(() => baseFieldsFrom(null));
  const [srv, setSrv] = React.useState<ServerFieldsDraft>(emptyServerFields);
  const [services, setServices] = React.useState<string[]>([]);
  const [ping, setPing] = React.useState(false);
  const [thresholds, setThresholds] = React.useState<ThresholdDraft>(() => thresholdsToDraft(null));
  const [showThresholds, setShowThresholds] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      setBase(baseFieldsFrom(null));
      setSrv(emptyServerFields());
      setServices([]);
      setPing(false);
      setThresholds(thresholdsToDraft(null));
      setErrors({});
      setFormError(null);
    }
  }, [open]);

  const create = useApiMutation({
    mutationFn: (p: ServerCreate) => serversApi.create(p),
    invalidate: [qk.resources, qk.dashboard],
    success: (r) => `Server “${r.name}” added — install the agent to start collecting metrics`,
    errorTitle: false,
    onSuccess: (r) => {
      onOpenChange(false);
      onCreated?.(r);
    },
    onError: (e) => {
      const fe = fieldErrorsOf(e);
      setErrors(fe);
      setFormError(e);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const { payload, errors: errs } = buildServerPayload(base, srv, services, ping, thresholds);
    setErrors(errs);
    if (payload) create.mutate(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
          <DialogDescription>Register a server, then enroll the eMonitor agent to collect metrics and logs.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="flex flex-col gap-4">
            {formError !== null && <InlineError error={formError} />}
            <BaseResourceFields value={base} onChange={setBase} errors={errors} idPrefix="srv" />
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Server</legend>
              <ServerFields value={srv} onChange={setSrv} errors={errors} idPrefix="srv" />
              <div className="mt-3 flex flex-col gap-3">
                <Field label="Monitored services" htmlFor="srv-services" error={errors.monitored_services}
                  hint="systemd units / Windows services the agent should watch, e.g. nginx, postgresql">
                  <TagInput id="srv-services" value={services} onChange={setServices} />
                </Field>
                <CheckboxField id="srv-ping" label="Add an ICMP ping check" checked={ping} onCheckedChange={setPing}
                  hint="Pings the IP address (or hostname) every 60 seconds" />
              </div>
            </fieldset>
            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowThresholds((v) => !v)} aria-expanded={showThresholds}>
                {showThresholds ? "Hide" : "Customize"} alert thresholds
              </Button>
              {showThresholds && (
                <div className="mt-2 rounded-md border p-3">
                  <ThresholdsEditor value={thresholds} onChange={setThresholds} errors={errors} idPrefix="srv-th" />
                </div>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Add server</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

