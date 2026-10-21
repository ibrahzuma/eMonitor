import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Send, Trash2, X } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { notificationsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { KeyValueEditor, PageHeader, Pagination, RelativeTime, SeverityBadge, StatusBadge, pairsToRecord, recordToPairs } from "@/components/common";
import { ChannelPicker, MemberPicker, MultiSelect, TeamPicker, useChannels } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import {
  type Channel,
  type ChannelIn,
  CHANNEL_TYPES,
  type ChannelType,
  DELIVERY_STATUSES,
  type JsonObject,
  type Policy,
  type PolicyIn,
  SEVERITIES,
  type Severity,
} from "@/types/api";
import { formatDateTime, getDisplayTimeZone, humanize, listTimeZones, splitList } from "@/utils/format";

const TYPE_LABELS: Record<ChannelType, string> = { email: "Email", telegram: "Telegram", webhook: "Webhook", in_app: "In-app" };

export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "channels";
  return (
    <div>
      <PageHeader title="Notifications" description="Channels deliver alerts; policies route incidents to channels with escalation." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="deliveries">Delivery log</TabsTrigger>
        </TabsList>
        <TabsContent value="channels"><ChannelsTab /></TabsContent>
        <TabsContent value="policies"><PoliciesTab /></TabsContent>
        <TabsContent value="deliveries"><DeliveriesTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- channels

interface ChannelForm {
  name: string;
  type: ChannelType;
  enabled: boolean;
  rate_limit_per_hour: string;
  // email
  to: string;
  smtp_host: string;
  smtp_port: string;
  smtp_username: string;
  starttls: boolean;
  use_ssl: boolean;
  from_address: string;
  smtp_password: string;
  // telegram
  chat_id: string;
  parse_mode: string;
  bot_token: string;
  // webhook
  url: string;
  method: string;
  headers: [string, string][];
  timeout_seconds: string;
  signing_secret: string;
  secret_headers: [string, string][];
  // in_app
  audience: string;
  user_ids: string[];
}

function str(v: unknown, d = ""): string {
  return v === undefined || v === null ? d : String(v);
}

function channelToForm(c?: Channel | null): ChannelForm {
  const cfg = (c?.config ?? {}) as Record<string, unknown>;
  return {
    name: c?.name ?? "",
    type: c?.type ?? "email",
    enabled: c?.enabled ?? true,
    rate_limit_per_hour: String(c?.rate_limit_per_hour ?? 60),
    to: Array.isArray(cfg.to) ? (cfg.to as unknown[]).map(String).join(", ") : "",
    smtp_host: str(cfg.smtp_host),
    smtp_port: str(cfg.smtp_port, "587"),
    smtp_username: str(cfg.smtp_username),
    starttls: cfg.starttls === undefined ? true : cfg.starttls === true,
    use_ssl: cfg.use_ssl === true,
    from_address: str(cfg.from_address),
    smtp_password: "",
    chat_id: str(cfg.chat_id),
    parse_mode: str(cfg.parse_mode),
    bot_token: "",
    url: str(cfg.url),
    method: str(cfg.method, "POST"),
    headers: recordToPairs(cfg.headers),
    timeout_seconds: str(cfg.timeout_seconds, "10"),
    signing_secret: "",
    secret_headers: [],
    audience: str(cfg.audience, "organization"),
    user_ids: Array.isArray(cfg.user_ids) ? (cfg.user_ids as unknown[]).map(String) : [],
  };
}

/** Build the channel payload; secrets are only included when any secret field was typed. */
function channelPayload(f: ChannelForm, isEdit: boolean): { payload: ChannelIn | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = "Name is required";
  const rate = Number(f.rate_limit_per_hour);
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) errors.rate_limit_per_hour = "Between 0 and 10000";
  let config: JsonObject = {};
  let secrets: JsonObject = {};
  if (f.type === "email") {
    const to = splitList(f.to);
    if (!to.length) errors.to = "At least one recipient is required";
    else if (to.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) errors.to = "Enter valid email addresses";
    config = { to, smtp_port: Number(f.smtp_port) || 587, starttls: f.starttls, use_ssl: f.use_ssl };
    if (f.smtp_host.trim()) config.smtp_host = f.smtp_host.trim();
    if (f.smtp_username.trim()) config.smtp_username = f.smtp_username.trim();
    if (f.from_address.trim()) config.from_address = f.from_address.trim();
    if (f.smtp_password) secrets = { smtp_password: f.smtp_password };
  } else if (f.type === "telegram") {
    if (!f.chat_id.trim()) errors.chat_id = "Chat ID is required";
    config = { chat_id: f.chat_id.trim() };
    if (f.parse_mode) config.parse_mode = f.parse_mode;
    if (f.bot_token) {
      if (f.bot_token.length < 10) errors.bot_token = "Bot token looks too short";
      secrets = { bot_token: f.bot_token };
    } else if (!isEdit) errors.bot_token = "Bot token is required";
  } else if (f.type === "webhook") {
    try {
      const u = new URL(f.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") errors.url = "URL must be http(s)";
    } catch {
      errors.url = "Enter a valid URL";
    }
    const t = Number(f.timeout_seconds);
    if (!(t > 0 && t <= 30)) errors.timeout_seconds = "Between 1 and 30 seconds";
    config = { url: f.url.trim(), method: f.method, headers: pairsToRecord(f.headers), timeout_seconds: t };
    if (f.signing_secret) secrets.signing_secret = f.signing_secret;
    const sh = pairsToRecord(f.secret_headers);
    if (Object.keys(sh).length) secrets.headers = sh;
  } else {
    config = { audience: f.audience, user_ids: f.audience === "users" ? f.user_ids : [] };
    if (f.audience === "users" && !f.user_ids.length) errors.user_ids = "Select at least one user";
  }
  if (Object.keys(errors).length) return { payload: null, errors };
  const payload: ChannelIn = { name: f.name.trim(), type: f.type, config, enabled: f.enabled, rate_limit_per_hour: rate };
  if (Object.keys(secrets).length) payload.secrets = secrets;
  return { payload, errors };
}

function ChannelDialog({ open, onOpenChange, channel }: { open: boolean; onOpenChange: (o: boolean) => void; channel: Channel | null }) {
  const [f, setF] = React.useState<ChannelForm>(() => channelToForm(channel));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setF(channelToForm(channel));
      setErrors({});
    }
  }, [open, channel]);
  const set = <K extends keyof ChannelForm>(k: K, v: ChannelForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const save = useApiMutation({
    mutationFn: async () => {
      const { payload, errors: errs } = channelPayload(f, Boolean(channel));
      setErrors(errs);
      if (!payload) throw new Error("Please fix the highlighted fields");
      return channel ? notificationsApi.updateChannel(channel.id, payload) : notificationsApi.createChannel(payload);
    },
    invalidate: [qk.channels],
    success: channel ? "Channel updated" : "Channel created",
    errorTitle: "Could not save channel",
    onSuccess: () => onOpenChange(false),
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  const configured = channel?.secrets_configured ?? [];
  const secretHint = (key: string) => (configured.includes(key) ? "Configured — leave blank to keep the current value" : undefined);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{channel ? `Edit channel “${channel.name}”` : "New notification channel"}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Name" htmlFor="ch-name" error={errors.name} required className="sm:col-span-2">
                <Input id="ch-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Type" htmlFor="ch-type">
                <NativeSelect id="ch-type" value={f.type} disabled={Boolean(channel)} onChange={(e) => set("type", e.target.value as ChannelType)}>
                  {CHANNEL_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                </NativeSelect>
              </Field>
            </div>
            {f.type === "email" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Recipients" htmlFor="ch-to" error={errors.to} required hint="Comma separated email addresses" className="sm:col-span-2">
                  <Input id="ch-to" value={f.to} onChange={(e) => set("to", e.target.value)} />
                </Field>
                <Field label="SMTP host" htmlFor="ch-host" hint="Blank = platform SMTP settings">
                  <Input id="ch-host" value={f.smtp_host} onChange={(e) => set("smtp_host", e.target.value)} />
                </Field>
                <Field label="SMTP port" htmlFor="ch-port">
                  <Input id="ch-port" type="number" value={f.smtp_port} onChange={(e) => set("smtp_port", e.target.value)} />
                </Field>
                <Field label="SMTP username" htmlFor="ch-user">
                  <Input id="ch-user" value={f.smtp_username} onChange={(e) => set("smtp_username", e.target.value)} autoComplete="off" />
                </Field>
                <Field label="SMTP password" htmlFor="ch-pass" hint={secretHint("smtp_password")}>
                  <Input id="ch-pass" type="password" autoComplete="new-password" value={f.smtp_password} onChange={(e) => set("smtp_password", e.target.value)} />
                </Field>
                <Field label="From address" htmlFor="ch-from">
                  <Input id="ch-from" value={f.from_address} onChange={(e) => set("from_address", e.target.value)} />
                </Field>
                <div className="flex flex-col gap-2 pt-5">
                  <CheckboxField id="ch-starttls" label="STARTTLS" checked={f.starttls} onCheckedChange={(v) => set("starttls", v)} />
                  <CheckboxField id="ch-ssl" label="Implicit TLS (SMTPS)" checked={f.use_ssl} onCheckedChange={(v) => set("use_ssl", v)} />
                </div>
              </div>
            )}
            {f.type === "telegram" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Chat ID" htmlFor="ch-chat" error={errors.chat_id} required>
                  <Input id="ch-chat" value={f.chat_id} onChange={(e) => set("chat_id", e.target.value)} />
                </Field>
                <Field label="Parse mode" htmlFor="ch-parse">
                  <NativeSelect id="ch-parse" value={f.parse_mode} onChange={(e) => set("parse_mode", e.target.value)}>
                    <option value="">Plain text</option><option value="HTML">HTML</option><option value="MarkdownV2">MarkdownV2</option>
                  </NativeSelect>
                </Field>
                <Field label="Bot token" htmlFor="ch-token" error={errors.bot_token} required={!channel} hint={secretHint("bot_token")} className="sm:col-span-2">
                  <Input id="ch-token" type="password" autoComplete="new-password" value={f.bot_token} onChange={(e) => set("bot_token", e.target.value)} />
                </Field>
              </div>
            )}
            {f.type === "webhook" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="URL" htmlFor="ch-url" error={errors.url} required className="sm:col-span-3">
                  <Input id="ch-url" value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://hooks.example.com/emonitor" />
                </Field>
                <Field label="Method" htmlFor="ch-method">
                  <NativeSelect id="ch-method" value={f.method} onChange={(e) => set("method", e.target.value)}>
                    <option>POST</option><option>PUT</option>
                  </NativeSelect>
                </Field>
                <Field label="Timeout (s)" htmlFor="ch-timeout" error={errors.timeout_seconds}>
                  <Input id="ch-timeout" type="number" min={1} max={30} value={f.timeout_seconds} onChange={(e) => set("timeout_seconds", e.target.value)} />
                </Field>
                <Field label="Signing secret" htmlFor="ch-sign" hint={secretHint("signing_secret") ?? "HMAC-SHA256 in X-EMonitor-Signature"}>
                  <Input id="ch-sign" type="password" autoComplete="new-password" value={f.signing_secret} onChange={(e) => set("signing_secret", e.target.value)} />
                </Field>
                <div className="flex flex-col gap-1 sm:col-span-3">
                  <span className="text-xs font-medium">Headers</span>
                  <KeyValueEditor idPrefix="ch-h" value={f.headers} onChange={(v) => set("headers", v)} />
                </div>
                <div className="flex flex-col gap-1 sm:col-span-3">
                  <span className="text-xs font-medium">Secret headers {configured.includes("headers") && <span className="text-muted-foreground">(configured — add to replace)</span>}</span>
                  <KeyValueEditor idPrefix="ch-sh" value={f.secret_headers} onChange={(v) => set("secret_headers", v)} secret />
                </div>
              </div>
            )}
            {f.type === "in_app" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Audience" htmlFor="ch-aud">
                  <NativeSelect id="ch-aud" value={f.audience} onChange={(e) => set("audience", e.target.value)}>
                    <option value="organization">Everyone in the organization</option>
                    <option value="team">Members of the incident's team</option>
                    <option value="users">Specific users</option>
                  </NativeSelect>
                </Field>
                {f.audience === "users" && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Users</span>
                    <MemberPicker id="ch-users" value={f.user_ids} onChange={(v) => set("user_ids", v)} />
                    {errors.user_ids && <p role="alert" className="text-xs text-destructive">{errors.user_ids}</p>}
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Rate limit (messages / hour)" htmlFor="ch-rate" error={errors.rate_limit_per_hour} hint="0 = unlimited">
                <Input id="ch-rate" type="number" min={0} max={10000} value={f.rate_limit_per_hour} onChange={(e) => set("rate_limit_per_hour", e.target.value)} />
              </Field>
              <div className="pt-5"><CheckboxField id="ch-enabled" label="Enabled" checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} /></div>
            </div>
            <p className="text-xs text-muted-foreground">Secrets are encrypted at rest and never returned by the API.</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{channel ? "Save channel" : "Create channel"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function channelToIn(c: Channel, enabled: boolean): ChannelIn {
  return { name: c.name, type: c.type, config: c.config, enabled, rate_limit_per_hour: c.rate_limit_per_hour };
}

function ChannelsTab() {
  const canManage = useCan("notifications:manage");
  const q = useChannels();
  const [editing, setEditing] = React.useState<Channel | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Channel | null>(null);
  const test = useApiMutation({ mutationFn: (id: string) => notificationsApi.testChannel(id), success: (m) => m.message, invalidate: [qk.channels] });
  const toggle = useApiMutation({
    mutationFn: (c: Channel) => notificationsApi.updateChannel(c.id, channelToIn(c, !c.enabled)),
    success: (c) => (c.enabled ? "Channel enabled" : "Channel disabled"),
    invalidate: [qk.channels],
  });
  const remove = useApiMutation({
    mutationFn: (id: string) => notificationsApi.deleteChannel(id), success: "Channel deleted", invalidate: [qk.channels],
    onSuccess: () => setDeleting(null),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Channels</CardTitle>
        {canManage && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> New channel</Button>}
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No notification channels" description="Create an email, Telegram, webhook or in-app channel, then reference it from a policy." />
      ) : (
        <Table>
          <THead><TR><TH>Name</TH><TH>Type</TH><TH>Enabled</TH><TH>Rate limit</TH><TH>Secrets</TH><TH>Last test</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {q.data.map((c) => (
              <TR key={c.id}>
                <TD className="font-medium">{c.name}</TD>
                <TD><Badge variant="outline">{TYPE_LABELS[c.type] ?? c.type}</Badge></TD>
                <TD>
                  <Switch checked={c.enabled} disabled={!canManage || toggle.isPending} aria-label={`${c.enabled ? "Disable" : "Enable"} ${c.name}`}
                    onCheckedChange={() => toggle.mutate(c)} />
                </TD>
                <TD className="tabular">{c.rate_limit_per_hour ? `${c.rate_limit_per_hour}/h` : "unlimited"}</TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {c.secrets_configured.length ? c.secrets_configured.map((s) => <Badge key={s} variant="success">{s}</Badge>) : <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                </TD>
                <TD>
                  {c.last_test_at ? (
                    <span className="flex items-center gap-1.5">
                      <RelativeTime value={c.last_test_at} />
                      {c.last_test_ok === true && <Badge variant="success">ok</Badge>}
                      {c.last_test_ok === false && <Badge variant="destructive">failed</Badge>}
                      {c.last_test_ok === null && <Badge variant="warning">pending</Badge>}
                    </span>
                  ) : <span className="text-xs text-muted-foreground">never</span>}
                </TD>
                <TD className="text-right">
                  {canManage && (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => test.mutate(c.id)} aria-label={`Test ${c.name}`}><Send /> Test</Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => { setEditing(c); setOpen(true); }}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Trash2 className="text-destructive" /></Button>
                    </div>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <ChannelDialog open={open} onOpenChange={setOpen} channel={editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete channel “${deleting?.name ?? ""}”?`}
        description="Policies referencing this channel will no longer deliver to it." destructive confirmLabel="Delete"
        loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- policies

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface StepForm { delay_minutes: string; channel_ids: string[] }

interface PolicyForm extends Omit<PolicyIn, "steps" | "priority" | "templates"> {
  steps: StepForm[];
  priority: string;
  subject: string;
  body: string;
}

function policyToForm(p: Policy | null): PolicyForm {
  return {
    name: p?.name ?? "",
    description: p?.description ?? "",
    is_default: p?.is_default ?? false,
    min_severity: (p?.min_severity as Severity) ?? "info",
    team_ids: p?.team_ids ?? [],
    steps: p?.steps.map((s) => ({ delay_minutes: String(s.delay_minutes ?? 0), channel_ids: s.channel_ids ?? [] })) ?? [{ delay_minutes: "0", channel_ids: [] }],
    notify_on_ack: p?.notify_on_ack ?? false,
    notify_on_resolve: p?.notify_on_resolve ?? true,
    quiet_hours: {
      enabled: p?.quiet_hours?.enabled ?? false,
      start: p?.quiet_hours?.start ?? "22:00",
      end: p?.quiet_hours?.end ?? "07:00",
      timezone: p?.quiet_hours?.timezone ?? getDisplayTimeZone(),
      allow_critical: p?.quiet_hours?.allow_critical ?? true,
      weekdays: p?.quiet_hours?.weekdays ?? [],
    },
    subject: p?.templates?.subject ?? "",
    body: p?.templates?.body ?? "",
    priority: String(p?.priority ?? 100),
    enabled: p?.enabled ?? true,
  };
}

function policyPayload(f: PolicyForm): { payload: PolicyIn | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = "Name is required";
  if (!f.steps.length) errors.steps = "Add at least one escalation step";
  f.steps.forEach((s, i) => {
    const d = Number(s.delay_minutes);
    if (!Number.isInteger(d) || d < 0 || d > 10080) errors[`steps.${i}.delay`] = "0–10080 minutes";
    if (!s.channel_ids.length) errors[`steps.${i}.channels`] = "Select at least one channel";
  });
  const prio = Number(f.priority);
  if (!Number.isInteger(prio) || prio < 0 || prio > 10000) errors.priority = "0–10000";
  if (f.quiet_hours.enabled && (!/^\d{2}:\d{2}$/.test(f.quiet_hours.start) || !/^\d{2}:\d{2}$/.test(f.quiet_hours.end))) errors.quiet = "Use HH:MM";
  if (Object.keys(errors).length) return { payload: null, errors };
  const templates: PolicyIn["templates"] = {};
  if (f.subject.trim()) templates.subject = f.subject;
  if (f.body.trim()) templates.body = f.body;
  return {
    payload: {
      name: f.name.trim(), description: f.description, is_default: f.is_default, min_severity: f.min_severity, team_ids: f.team_ids,
      steps: f.steps.map((s) => ({ delay_minutes: Number(s.delay_minutes), channel_ids: s.channel_ids })),
      notify_on_ack: f.notify_on_ack, notify_on_resolve: f.notify_on_resolve, quiet_hours: f.quiet_hours, templates,
      priority: prio, enabled: f.enabled,
    },
    errors,
  };
}

function PolicyDialog({ open, onOpenChange, policy }: { open: boolean; onOpenChange: (o: boolean) => void; policy: Policy | null }) {
  const [f, setF] = React.useState<PolicyForm>(() => policyToForm(policy));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const zones = React.useMemo(listTimeZones, []);
  React.useEffect(() => {
    if (open) { setF(policyToForm(policy)); setErrors({}); }
  }, [open, policy]);
  const set = <K extends keyof PolicyForm>(k: K, v: PolicyForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const setQh = <K extends keyof PolicyForm["quiet_hours"]>(k: K, v: PolicyForm["quiet_hours"][K]) =>
    setF((p) => ({ ...p, quiet_hours: { ...p.quiet_hours, [k]: v } }));
  const setStep = (i: number, s: Partial<StepForm>) => setF((p) => ({ ...p, steps: p.steps.map((x, j) => (j === i ? { ...x, ...s } : x)) }));
  const move = (i: number, d: -1 | 1) => setF((p) => {
    const steps = [...p.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return p;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    return { ...p, steps };
  });
  const save = useApiMutation({
    mutationFn: async () => {
      const { payload, errors: errs } = policyPayload(f);
      setErrors(errs);
      if (!payload) throw new Error("Please fix the highlighted fields");
      return policy ? notificationsApi.updatePolicy(policy.id, payload) : notificationsApi.createPolicy(payload);
    },
    invalidate: [qk.policies],
    success: policy ? "Policy updated" : "Policy created",
    errorTitle: "Could not save policy",
    onSuccess: () => onOpenChange(false),
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{policy ? `Edit policy “${policy.name}”` : "New notification policy"}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Name" htmlFor="pol-name" error={errors.name} required className="sm:col-span-2">
                <Input id="pol-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Minimum severity" htmlFor="pol-sev">
                <NativeSelect id="pol-sev" value={f.min_severity} onChange={(e) => set("min_severity", e.target.value as Severity)}>
                  {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Description" htmlFor="pol-desc" className="sm:col-span-3">
                <Textarea id="pol-desc" rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />
              </Field>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <span className="text-xs font-medium">Teams (empty = all incidents)</span>
                <TeamPicker id="pol-teams" value={f.team_ids} onChange={(v) => set("team_ids", v)} />
              </div>
              <Field label="Priority" htmlFor="pol-prio" error={errors.priority} hint="Lower is evaluated first">
                <Input id="pol-prio" type="number" value={f.priority} onChange={(e) => set("priority", e.target.value)} />
              </Field>
            </div>
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Escalation steps</legend>
              {errors.steps && <p role="alert" className="mb-2 text-xs text-destructive">{errors.steps}</p>}
              <ol className="flex flex-col gap-3">
                {f.steps.map((s, i) => (
                  <li key={i} className="grid grid-cols-1 items-start gap-2 rounded border bg-muted/30 p-2 sm:grid-cols-[110px_1fr_auto]">
                    <Field label={`Step ${i + 1} delay (min)`} htmlFor={`pol-step-${i}-delay`} error={errors[`steps.${i}.delay`]}>
                      <Input id={`pol-step-${i}-delay`} type="number" min={0} value={s.delay_minutes} onChange={(e) => setStep(i, { delay_minutes: e.target.value })} />
                    </Field>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium">Channels</span>
                      <ChannelPicker id={`pol-step-${i}-ch`} value={s.channel_ids} onChange={(v) => setStep(i, { channel_ids: v })} />
                      {errors[`steps.${i}.channels`] && <p role="alert" className="text-xs text-destructive">{errors[`steps.${i}.channels`]}</p>}
                    </div>
                    <div className="flex gap-1 pt-5">
                      <Button variant="ghost" size="icon-sm" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Move step ${i + 1} down`} disabled={i === f.steps.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove step ${i + 1}`} disabled={f.steps.length === 1}
                        onClick={() => set("steps", f.steps.filter((_, j) => j !== i))}><X /></Button>
                    </div>
                  </li>
                ))}
              </ol>
              <Button variant="outline" size="sm" className="mt-2" disabled={f.steps.length >= 10}
                onClick={() => set("steps", [...f.steps, { delay_minutes: "15", channel_ids: [] }])}><Plus /> Add step</Button>
            </fieldset>
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Quiet hours</legend>
              <div className="flex flex-col gap-3">
                <CheckboxField id="pol-qh" label="Enable quiet hours" checked={f.quiet_hours.enabled} onCheckedChange={(v) => setQh("enabled", v)} />
                {f.quiet_hours.enabled && (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Field label="Start" htmlFor="pol-qh-start" error={errors.quiet}>
                        <Input id="pol-qh-start" type="time" value={f.quiet_hours.start} onChange={(e) => setQh("start", e.target.value)} />
                      </Field>
                      <Field label="End" htmlFor="pol-qh-end">
                        <Input id="pol-qh-end" type="time" value={f.quiet_hours.end} onChange={(e) => setQh("end", e.target.value)} />
                      </Field>
                      <Field label="Time zone" htmlFor="pol-qh-tz" className="col-span-2">
                        <NativeSelect id="pol-qh-tz" value={f.quiet_hours.timezone} onChange={(e) => setQh("timezone", e.target.value)}>
                          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                        </NativeSelect>
                      </Field>
                    </div>
                    <div className="flex flex-wrap gap-3" role="group" aria-label="Quiet hour weekdays (none = every day)">
                      {WEEKDAYS.map((d, i) => (
                        <CheckboxField key={d} id={`pol-qh-wd-${i}`} label={d} checked={f.quiet_hours.weekdays.includes(i)}
                          onCheckedChange={(v) => setQh("weekdays", v ? [...f.quiet_hours.weekdays, i].sort() : f.quiet_hours.weekdays.filter((x) => x !== i))} />
                      ))}
                    </div>
                    <CheckboxField id="pol-qh-crit" label="Critical incidents still notify during quiet hours" checked={f.quiet_hours.allow_critical}
                      onCheckedChange={(v) => setQh("allow_critical", v)} />
                  </>
                )}
              </div>
            </fieldset>
            <fieldset className="rounded-md border p-3">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">Message templates</legend>
              <p className="mb-2 text-xs text-muted-foreground">Jinja-style template; leave blank for default. Variables: {"{{ event_label }} {{ severity }} {{ number }} {{ title }} {{ status }} {{ resource }} {{ condition }} {{ first_detected }} {{ resolution }} {{ url }}"}.</p>
              <div className="flex flex-col gap-3">
                <Field label="Subject" htmlFor="pol-subj"><Input id="pol-subj" value={f.subject} onChange={(e) => set("subject", e.target.value)} className="font-mono text-xs" /></Field>
                <Field label="Body" htmlFor="pol-body"><Textarea id="pol-body" rows={4} value={f.body} onChange={(e) => set("body", e.target.value)} className="font-mono text-xs" /></Field>
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-4">
              <CheckboxField id="pol-ack" label="Notify on acknowledge" checked={f.notify_on_ack} onCheckedChange={(v) => set("notify_on_ack", v)} />
              <CheckboxField id="pol-res" label="Notify on resolve" checked={f.notify_on_resolve} onCheckedChange={(v) => set("notify_on_resolve", v)} />
              <CheckboxField id="pol-def" label="Default policy" checked={f.is_default} onCheckedChange={(v) => set("is_default", v)} />
              <CheckboxField id="pol-en" label="Enabled" checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{policy ? "Save policy" : "Create policy"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PoliciesTab() {
  const canManage = useCan("notifications:manage");
  const q = useQuery({ queryKey: qk.policies, queryFn: notificationsApi.policies });
  const [editing, setEditing] = React.useState<Policy | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Policy | null>(null);
  const remove = useApiMutation({
    mutationFn: (id: string) => notificationsApi.deletePolicy(id), success: "Policy deleted", invalidate: [qk.policies],
    onSuccess: () => setDeleting(null),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Policies</CardTitle>
        {canManage && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> New policy</Button>}
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No notification policies" description="Policies decide which channels are notified and how incidents escalate." />
      ) : (
        <Table>
          <THead><TR><TH>Name</TH><TH>Min severity</TH><TH>Steps</TH><TH>Quiet hours</TH><TH>Priority</TH><TH>Enabled</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {q.data.map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.name} {p.is_default && <Badge variant="default" className="ml-1">default</Badge>}
                  {p.description && <p className="text-xs font-normal text-muted-foreground">{p.description}</p>}</TD>
                <TD><SeverityBadge severity={p.min_severity} /></TD>
                <TD className="text-xs">{p.steps.map((s, i) => `${i + 1}: +${s.delay_minutes}m → ${s.channel_ids.length} ch`).join(" · ")}</TD>
                <TD className="text-xs">{p.quiet_hours?.enabled ? `${p.quiet_hours.start}–${p.quiet_hours.end} ${p.quiet_hours.timezone}` : "—"}</TD>
                <TD className="tabular">{p.priority}</TD>
                <TD>{p.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="outline">disabled</Badge>}</TD>
                <TD className="text-right">
                  {canManage && (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${p.name}`} onClick={() => { setEditing(p); setOpen(true); }}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)}><Trash2 className="text-destructive" /></Button>
                    </div>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <PolicyDialog open={open} onOpenChange={setOpen} policy={editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete policy “${deleting?.name ?? ""}”?`}
        destructive confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- deliveries

function DeliveriesTab() {
  const canManage = useCan("notifications:manage");
  const [status, setStatus] = React.useState<string[]>([]);
  const [page, setPage] = React.useState(1);
  const query = { status, page, page_size: 50 };
  const q = useQuery({ queryKey: qk.deliveries(query), queryFn: () => notificationsApi.deliveries(query) });
  const channels = useChannels();
  const names = new Map((channels.data ?? []).map((c) => [c.id, c.name] as const));
  const retry = useApiMutation({
    mutationFn: (id: string) => notificationsApi.retryDelivery(id), success: (m) => m.message, invalidate: [["notifications", "deliveries"]],
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery log</CardTitle>
        <div className="w-56">
          <MultiSelect ariaLabel="Filter by status" placeholder="All statuses" value={status}
            onChange={(v) => { setStatus(v); setPage(1); }} options={DELIVERY_STATUSES.map((s) => ({ value: s, label: humanize(s), status: s }))} />
        </div>
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.items.length ? (
        <EmptyState title="No deliveries" description="Notification attempts (including channel tests) appear here." />
      ) : (
        <>
          <Table>
            <THead><TR><TH>Created</TH><TH>Channel</TH><TH>Event</TH><TH>Status</TH><TH>Attempts</TH><TH>Subject</TH><TH>Last error</TH><TH>Incident</TH><TH /></TR></THead>
            <TBody>
              {q.data.items.map((d) => (
                <TR key={d.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(d.created_at, { seconds: true })}</TD>
                  <TD>{d.channel_id ? names.get(d.channel_id) ?? <span className="text-muted-foreground">deleted</span> : "—"} <Badge variant="outline">{d.channel_type}</Badge></TD>
                  <TD>{humanize(d.event)}{d.step > 0 && <span className="text-xs text-muted-foreground"> · step {d.step + 1}</span>}</TD>
                  <TD><StatusBadge status={d.status} />{d.status_reason && <p className="text-xs text-muted-foreground">{d.status_reason}</p>}</TD>
                  <TD className="tabular">{d.attempts}/{d.max_attempts}</TD>
                  <TD className="max-w-[280px] truncate" title={d.subject}>{d.subject}</TD>
                  <TD className="max-w-[260px] truncate text-xs text-destructive" title={d.last_error}>{d.last_error || ""}</TD>
                  <TD>{d.incident_id ? <Link className="text-xs text-primary hover:underline" to={`/incidents/${d.incident_id}`}>Open</Link> : "—"}</TD>
                  <TD>
                    {canManage && d.status === "failed" && (
                      <Button variant="outline" size="sm" onClick={() => retry.mutate(d.id)} loading={retry.isPending && retry.variables === d.id}><RotateCcw /> Retry</Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={50} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
