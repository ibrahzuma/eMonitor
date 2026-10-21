import * as React from "react";
import { useNavigate } from "react-router-dom";
import { devicesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { InlineError } from "@/components/ui/states";
import { BaseResourceFields, type BaseFieldsState, baseFieldsFrom, baseFieldsPayload } from "@/features/resources/panels";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { DeviceType, JsonObject, NetworkDeviceCreate } from "@/types/api";
import { humanize } from "@/utils/format";

// ---------------------------------------------------------------- add device

const DEVICE_TYPES: DeviceType[] = ["router", "switch", "firewall", "access_point", "load_balancer", "other"];

interface DeviceForm {
  base: BaseFieldsState;
  host: string;
  vendor: string;
  model: string;
  device_type: DeviceType;
  ping: boolean;
  ping_interval_seconds: string;
  snmp: boolean;
  version: "1" | "2c" | "3";
  port: string;
  collect_interfaces: boolean;
  max_interfaces: string;
  v3_username: string;
  v3_security_level: string;
  v3_auth_protocol: string;
  v3_priv_protocol: string;
  community: string;
  v3_auth_key: string;
  v3_priv_key: string;
  snmp_interval_seconds: string;
}

function initialForm(): DeviceForm {
  return {
    base: baseFieldsFrom(null), host: "", vendor: "", model: "", device_type: "other", ping: true, ping_interval_seconds: "60",
    snmp: false, version: "2c", port: "161", collect_interfaces: true, max_interfaces: "64", v3_username: "",
    v3_security_level: "authPriv", v3_auth_protocol: "sha", v3_priv_protocol: "aes128", community: "", v3_auth_key: "",
    v3_priv_key: "", snmp_interval_seconds: "300",
  };
}

export function buildDevicePayload(f: DeviceForm): { payload: NetworkDeviceCreate | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.base.name.trim()) errors.name = "Name is required";
  if (!f.host.trim()) errors.host = "Host is required";
  if (!f.ping && !f.snmp) errors.monitoring = "Enable ping and/or SNMP monitoring";
  const pingInterval = Number(f.ping_interval_seconds);
  if (f.ping && (!Number.isInteger(pingInterval) || pingInterval < 10 || pingInterval > 86400)) errors.ping_interval_seconds = "Between 10 and 86400 seconds";
  const snmpInterval = Number(f.snmp_interval_seconds);
  const port = Number(f.port);
  const maxIf = Number(f.max_interfaces);
  if (f.snmp) {
    if (!Number.isInteger(snmpInterval) || snmpInterval < 30 || snmpInterval > 86400) errors.snmp_interval_seconds = "Between 30 and 86400 seconds";
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = "Port must be between 1 and 65535";
    if (!Number.isInteger(maxIf) || maxIf < 1 || maxIf > 512) errors.max_interfaces = "Between 1 and 512";
    if (f.version === "3" && !f.v3_username.trim()) errors.v3_username = "SNMPv3 requires a username";
  }
  if (Object.keys(errors).length) return { payload: null, errors };
  const payload: NetworkDeviceCreate = {
    ...baseFieldsPayload(f.base),
    host: f.host.trim(),
    vendor: f.vendor.trim(),
    model: f.model.trim(),
    device_type: f.device_type,
    ping: f.ping,
    ping_interval_seconds: f.ping ? pingInterval : 60,
    snmp: null,
  };
  if (f.snmp) {
    const snmp: JsonObject = { port, version: f.version, collect_interfaces: f.collect_interfaces, max_interfaces: maxIf };
    const secrets: JsonObject = {};
    if (f.version === "3") {
      snmp.v3_username = f.v3_username.trim();
      snmp.v3_security_level = f.v3_security_level;
      snmp.v3_auth_protocol = f.v3_auth_protocol;
      snmp.v3_priv_protocol = f.v3_priv_protocol;
      if (f.v3_auth_key) secrets.v3_auth_key = f.v3_auth_key;
      if (f.v3_priv_key) secrets.v3_priv_key = f.v3_priv_key;
    } else if (f.community) {
      secrets.community = f.community;
    }
    payload.snmp = snmp;
    payload.snmp_interval_seconds = snmpInterval;
    if (Object.keys(secrets).length) payload.snmp_secrets = secrets;
  }
  return { payload, errors };
}

export function AddDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const [f, setF] = React.useState<DeviceForm>(initialForm);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (open) {
      setF(initialForm());
      setErrors({});
      setFormError(null);
    }
  }, [open]);
  const set = <K extends keyof DeviceForm>(k: K, v: DeviceForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const create = useApiMutation({
    mutationFn: (p: NetworkDeviceCreate) => devicesApi.create(p),
    invalidate: [qk.resources, qk.dashboard],
    success: (r) => `Device “${r.name}” added`,
    errorTitle: false,
    onSuccess: (r) => {
      onOpenChange(false);
      navigate(`/network-devices/${r.id}`);
    },
    onError: (e) => {
      setErrors(fieldErrorsOf(e));
      setFormError(e);
    },
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const { payload, errors: errs } = buildDevicePayload(f);
    setErrors(errs);
    if (payload) create.mutate(payload);
  };
  const v3 = f.version === "3";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add network device</DialogTitle>
          <DialogDescription>Reachability via ICMP ping, plus optional SNMP polling of interfaces.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="flex flex-col gap-5">
            {formError !== null && <InlineError error={formError} />}
            {errors.monitoring && <p role="alert" className="text-sm text-destructive">{errors.monitoring}</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Host" htmlFor="dev-host" error={errors.host} required hint="Hostname or IP address">
                <Input id="dev-host" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="core-sw-01.lan or 10.0.0.2" />
              </Field>
              <Field label="Device type" htmlFor="dev-type">
                <NativeSelect id="dev-type" value={f.device_type} onChange={(e) => set("device_type", e.target.value as DeviceType)}>
                  {DEVICE_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Vendor" htmlFor="dev-vendor"><Input id="dev-vendor" value={f.vendor} onChange={(e) => set("vendor", e.target.value)} /></Field>
              <Field label="Model" htmlFor="dev-model"><Input id="dev-model" value={f.model} onChange={(e) => set("model", e.target.value)} /></Field>
            </div>
            <BaseResourceFields value={f.base} onChange={(b) => set("base", b)} errors={errors} idPrefix="dev" />
            <fieldset className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Ping</legend>
              <div className="flex items-end pb-1">
                <CheckboxField id="dev-ping" label="Monitor with ICMP ping" checked={f.ping} onCheckedChange={(v) => set("ping", v)} />
              </div>
              {f.ping && (
                <Field label="Ping interval (s)" htmlFor="dev-ping-int" error={errors.ping_interval_seconds}>
                  <Input id="dev-ping-int" type="number" min={10} value={f.ping_interval_seconds} onChange={(e) => set("ping_interval_seconds", e.target.value)} />
                </Field>
              )}
            </fieldset>
            <fieldset className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">SNMP</legend>
              <div className="sm:col-span-2">
                <CheckboxField id="dev-snmp" label="Poll via SNMP" checked={f.snmp} onCheckedChange={(v) => set("snmp", v)} />
              </div>
              {f.snmp && (
                <>
                  <Field label="Version" htmlFor="dev-snmp-ver">
                    <NativeSelect id="dev-snmp-ver" value={f.version} onChange={(e) => set("version", e.target.value as DeviceForm["version"])}>
                      <option value="1">v1</option><option value="2c">v2c</option><option value="3">v3</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Port" htmlFor="dev-snmp-port" error={errors.port}>
                    <Input id="dev-snmp-port" type="number" value={f.port} onChange={(e) => set("port", e.target.value)} />
                  </Field>
                  <Field label="Poll interval (s)" htmlFor="dev-snmp-int" error={errors.snmp_interval_seconds}>
                    <Input id="dev-snmp-int" type="number" min={30} value={f.snmp_interval_seconds} onChange={(e) => set("snmp_interval_seconds", e.target.value)} />
                  </Field>
                  <Field label="Max interfaces" htmlFor="dev-snmp-maxif" error={errors.max_interfaces}>
                    <Input id="dev-snmp-maxif" type="number" value={f.max_interfaces} onChange={(e) => set("max_interfaces", e.target.value)} />
                  </Field>
                  <div className="sm:col-span-2">
                    <CheckboxField id="dev-snmp-if" label="Collect interface statistics" checked={f.collect_interfaces} onCheckedChange={(v) => set("collect_interfaces", v)} />
                  </div>
                  {v3 ? (
                    <>
                      <Field label="SNMPv3 username" htmlFor="dev-v3-user" error={errors.v3_username} required>
                        <Input id="dev-v3-user" value={f.v3_username} onChange={(e) => set("v3_username", e.target.value)} />
                      </Field>
                      <Field label="Security level" htmlFor="dev-v3-level">
                        <NativeSelect id="dev-v3-level" value={f.v3_security_level} onChange={(e) => set("v3_security_level", e.target.value)}>
                          {["noAuthNoPriv", "authNoPriv", "authPriv"].map((x) => <option key={x} value={x}>{x}</option>)}
                        </NativeSelect>
                      </Field>
                      <Field label="Auth protocol" htmlFor="dev-v3-auth">
                        <NativeSelect id="dev-v3-auth" value={f.v3_auth_protocol} onChange={(e) => set("v3_auth_protocol", e.target.value)}>
                          {["none", "md5", "sha", "sha256", "sha512"].map((x) => <option key={x} value={x}>{x}</option>)}
                        </NativeSelect>
                      </Field>
                      <Field label="Privacy protocol" htmlFor="dev-v3-priv">
                        <NativeSelect id="dev-v3-priv" value={f.v3_priv_protocol} onChange={(e) => set("v3_priv_protocol", e.target.value)}>
                          {["none", "des", "aes128", "aes256"].map((x) => <option key={x} value={x}>{x}</option>)}
                        </NativeSelect>
                      </Field>
                      <Field label="Auth key (write-only)" htmlFor="dev-v3-ak">
                        <Input id="dev-v3-ak" type="password" autoComplete="new-password" value={f.v3_auth_key} onChange={(e) => set("v3_auth_key", e.target.value)} />
                      </Field>
                      <Field label="Privacy key (write-only)" htmlFor="dev-v3-pk">
                        <Input id="dev-v3-pk" type="password" autoComplete="new-password" value={f.v3_priv_key} onChange={(e) => set("v3_priv_key", e.target.value)} />
                      </Field>
                    </>
                  ) : (
                    <Field label="Community string (write-only)" htmlFor="dev-community" className="sm:col-span-2" hint="Stored encrypted; never displayed again">
                      <Input id="dev-community" type="password" autoComplete="new-password" value={f.community} onChange={(e) => set("community", e.target.value)} />
                    </Field>
                  )}
                </>
              )}
            </fieldset>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Add device</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
