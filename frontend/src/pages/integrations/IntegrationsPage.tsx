import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, KeyRound, Plus } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { API_BASE } from "@/api/client";
import { agentsApi, apiKeysApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { CodeBlock, CopyButton, PageHeader, RelativeTime, StatusBadge, TagInput } from "@/components/common";
import { GroupSelect } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth, useCan } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import {
  type ApiKey,
  type ApiKeyCreated,
  type AssignableRole,
  type EnrollmentToken,
  type EnrollmentTokenCreated,
  ENVIRONMENTS,
  PERMISSIONS,
  ROLES,
  type Agent,
} from "@/types/api";
import { formatDateTime, humanize, localInputToIso } from "@/utils/format";

export function IntegrationsPage() {
  const [params, setParams] = useSearchParams();
  const canKeys = useCan("api_keys:manage");
  const canAgents = useCan("agents:manage");
  const tabs = [
    ...(canKeys ? [{ v: "api-keys", l: "API keys" }] : []),
    ...(canAgents ? [{ v: "enrollment", l: "Agent enrollment" }] : []),
    { v: "agents", l: "Agents" },
    { v: "ingestion", l: "Ingestion" },
  ];
  const requested = params.get("tab");
  const tab = tabs.some((t) => t.v === requested) ? (requested as string) : tabs[0].v;
  return (
    <div>
      <PageHeader title="Integrations" description="API keys, agent enrollment and telemetry ingestion endpoints." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList>{tabs.map((t) => <TabsTrigger key={t.v} value={t.v}>{t.l}</TabsTrigger>)}</TabsList>
        {canKeys && <TabsContent value="api-keys"><ApiKeysTab /></TabsContent>}
        {canAgents && <TabsContent value="enrollment"><EnrollmentTab /></TabsContent>}
        <TabsContent value="agents"><AgentsTab /></TabsContent>
        <TabsContent value="ingestion"><IngestionTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function OneTimeSecret({ title, value, children }: { title: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Copy the {title.toLowerCase()} now. It is shown only once and cannot be retrieved later.</span>
      </div>
      <div className="flex items-center gap-2">
        <code data-testid="one-time-secret" className="min-w-0 flex-1 break-all rounded border bg-muted px-2 py-1.5 font-mono text-xs">{value}</code>
        <CopyButton value={value} label={`Copy ${title.toLowerCase()}`} />
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- API keys

const SCOPES = PERMISSIONS.filter((p) => p !== "platform:admin");

function ApiKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<AssignableRole>("viewer");
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [expires, setExpires] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [created, setCreated] = React.useState<ApiKeyCreated | null>(null);
  React.useEffect(() => {
    if (open) { setName(""); setRole("viewer"); setScopes([]); setExpires(""); setErrors({}); setCreated(null); }
  }, [open]);
  const create = useApiMutation({
    mutationFn: async () => {
      const errs: Record<string, string> = {};
      if (!name.trim()) errs.name = "Name is required";
      const expiresAt = expires ? localInputToIso(`${expires}T23:59`) : null;
      if (expiresAt && new Date(expiresAt) <= new Date()) errs.expires_at = "Expiry must be in the future";
      setErrors(errs);
      if (Object.keys(errs).length) throw new Error("Please fix the highlighted fields");
      return apiKeysApi.create({ name: name.trim(), role, scopes, expires_at: expiresAt });
    },
    invalidate: [qk.apiKeys],
    success: "API key created",
    errorTitle: "Could not create API key",
    onSuccess: (k) => setCreated(k),
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{created ? "API key created" : "New API key"}</DialogTitle></DialogHeader>
        {created ? (
          <>
            <DialogBody>
              <OneTimeSecret title="API key" value={created.key}>
                <p className="text-xs text-muted-foreground">Use it as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>. Role: {humanize(created.role)}.</p>
              </OneTimeSecret>
            </DialogBody>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogBody className="flex flex-col gap-3">
              <Field label="Name" htmlFor="key-name" error={errors.name} required>
                <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CI log shipper" />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Role" htmlFor="key-role" error={errors.role}>
                  <NativeSelect id="key-role" value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
                    {ROLES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
                  </NativeSelect>
                </Field>
                <Field label="Expires on" htmlFor="key-exp" error={errors.expires_at} hint="Optional">
                  <Input id="key-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
                </Field>
              </div>
              <fieldset className="rounded-md border p-3">
                <legend className="px-1 text-xs font-semibold text-muted-foreground">Restrict scopes (optional)</legend>
                <p className="mb-2 text-xs text-muted-foreground">Without scopes the key has all permissions of its role. Scopes outside the role have no effect.</p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {SCOPES.map((s) => (
                    <CheckboxField key={s} id={`scope-${s}`} label={<span className="font-mono text-xs">{s}</span>} checked={scopes.includes(s)}
                      onCheckedChange={(v) => setScopes(v ? [...scopes, s] : scopes.filter((x) => x !== s))} />
                  ))}
                </div>
                {errors.scopes && <p role="alert" className="mt-1 text-xs text-destructive">{errors.scopes}</p>}
              </fieldset>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" loading={create.isPending}>Create key</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApiKeysTab() {
  const q = useQuery({ queryKey: qk.apiKeys, queryFn: apiKeysApi.list });
  const [open, setOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiKey | null>(null);
  const revoke = useApiMutation({ mutationFn: (id: string) => apiKeysApi.revoke(id), success: "API key revoked", invalidate: [qk.apiKeys], onSuccess: () => setRevoking(null) });
  const now = Date.now();
  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}><Plus /> New API key</Button>
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState icon={<KeyRound />} title="No API keys" description="API keys authenticate integrations such as log shippers and metric exporters." />
      ) : (
        <Table>
          <THead><TR><TH>Name</TH><TH>Prefix</TH><TH>Role</TH><TH>Scopes</TH><TH>Created</TH><TH>Last used</TH><TH>Expires</TH><TH>Status</TH><TH /></TR></THead>
          <TBody>
            {q.data.map((k) => {
              const expired = k.expires_at ? new Date(k.expires_at).getTime() < now : false;
              return (
                <TR key={k.id}>
                  <TD className="font-medium">{k.name}</TD>
                  <TD className="font-mono text-xs">{k.prefix}…</TD>
                  <TD>{humanize(k.role)}</TD>
                  <TD><div className="flex max-w-xs flex-wrap gap-1">{k.scopes.length ? k.scopes.map((s) => <Badge key={s} variant="outline">{s}</Badge>) : <span className="text-xs text-muted-foreground">all of role</span>}</div></TD>
                  <TD className="text-xs">{formatDateTime(k.created_at)}</TD>
                  <TD><RelativeTime value={k.last_used_at} /></TD>
                  <TD className="text-xs">{k.expires_at ? formatDateTime(k.expires_at) : "never"}</TD>
                  <TD>{k.revoked_at ? <Badge variant="destructive">revoked</Badge> : expired ? <Badge variant="warning">expired</Badge> : <Badge variant="success">active</Badge>}</TD>
                  <TD className="text-right">
                    {!k.revoked_at && <Button variant="ghost" size="sm" onClick={() => setRevoking(k)}><Ban /> Revoke</Button>}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <ApiKeyDialog open={open} onOpenChange={setOpen} />
      <ConfirmDialog open={Boolean(revoking)} onOpenChange={(o) => !o && setRevoking(null)} title={`Revoke “${revoking?.name ?? ""}”?`}
        description="Integrations using this key stop working immediately." destructive confirmLabel="Revoke"
        loading={revoke.isPending} onConfirm={() => revoking && revoke.mutate(revoking.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- enrollment tokens

function InstallInstructions({ command }: { command: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-xs text-muted-foreground">1. Install the eMonitor agent package on the server (Linux: deb/rpm or the static binary; Windows: MSI), then run:</p>
      <CodeBlock code={command} />
      <p className="text-xs text-muted-foreground">
        2. The agent stores its credentials locally and starts reporting. On Linux enable the service with
        <code className="mx-1 font-mono">sudo systemctl enable --now emonitor-agent</code>. Enrollment tokens expire and can be used a limited number of times.
      </p>
    </div>
  );
}

function TokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [desc, setDesc] = React.useState("");
  const [maxUses, setMaxUses] = React.useState("10");
  const [hours, setHours] = React.useState("24");
  const [env, setEnv] = React.useState("");
  const [group, setGroup] = React.useState("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [created, setCreated] = React.useState<EnrollmentTokenCreated | null>(null);
  React.useEffect(() => {
    if (open) { setDesc(""); setMaxUses("10"); setHours("24"); setEnv(""); setGroup(""); setTags([]); setErrors({}); setCreated(null); }
  }, [open]);
  const create = useApiMutation({
    mutationFn: async () => {
      const errs: Record<string, string> = {};
      const mu = Number(maxUses);
      const h = Number(hours);
      if (!Number.isInteger(mu) || mu < 1 || mu > 1000) errs.max_uses = "1–1000";
      if (!Number.isInteger(h) || h < 1 || h > 720) errs.expires_in_hours = "1–720 hours";
      setErrors(errs);
      if (Object.keys(errs).length) throw new Error("Please fix the highlighted fields");
      return agentsApi.createToken({ description: desc, max_uses: mu, expires_in_hours: h, environment: env || null, group_id: group || null, tags });
    },
    invalidate: [qk.enrollmentTokens],
    success: "Enrollment token created",
    errorTitle: "Could not create token",
    onSuccess: (t) => setCreated(t),
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{created ? "Enrollment token created" : "New enrollment token"}</DialogTitle></DialogHeader>
        {created ? (
          <>
            <DialogBody>
              <OneTimeSecret title="Enrollment token" value={created.token}>
                <InstallInstructions command={created.install_command} />
              </OneTimeSecret>
            </DialogBody>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <form className="contents" noValidate onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <DialogBody className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Description" htmlFor="tok-desc" className="sm:col-span-2">
                <Input id="tok-desc" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} placeholder="Web tier rollout" />
              </Field>
              <Field label="Max uses" htmlFor="tok-uses" error={errors.max_uses}>
                <Input id="tok-uses" type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
              </Field>
              <Field label="Expires in (hours)" htmlFor="tok-hours" error={errors.expires_in_hours}>
                <Input id="tok-hours" type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} />
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-2">Defaults applied to servers that enroll with this token:</p>
              <Field label="Environment" htmlFor="tok-env">
                <NativeSelect id="tok-env" value={env} onChange={(e) => setEnv(e.target.value)}>
                  <option value="">Production (default)</option>
                  {ENVIRONMENTS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
                </NativeSelect>
              </Field>
              <Field label="Group" htmlFor="tok-group"><GroupSelect id="tok-group" value={group} onChange={setGroup} /></Field>
              <Field label="Tags" htmlFor="tok-tags" className="sm:col-span-2"><TagInput id="tok-tags" value={tags} onChange={setTags} /></Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" loading={create.isPending}>Create token</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EnrollmentTab() {
  const q = useQuery({ queryKey: qk.enrollmentTokens, queryFn: agentsApi.tokens });
  const [open, setOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<EnrollmentToken | null>(null);
  const revoke = useApiMutation({ mutationFn: (id: string) => agentsApi.revokeToken(id), success: "Token revoked", invalidate: [qk.enrollmentTokens], onSuccess: () => setRevoking(null) });
  const now = Date.now();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Enrollment tokens</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}><Plus /> New token</Button>
      </CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No enrollment tokens" description="Create a token to enroll agents. Servers are created automatically on first enrollment." />
      ) : (
        <Table>
          <THead><TR><TH>Description</TH><TH>Server</TH><TH>Uses</TH><TH>Created</TH><TH>Expires</TH><TH>Status</TH><TH /></TR></THead>
          <TBody>
            {q.data.map((t) => {
              const expired = new Date(t.expires_at).getTime() < now;
              const exhausted = t.use_count >= t.max_uses;
              return (
                <TR key={t.id}>
                  <TD>{t.description || <span className="text-muted-foreground">—</span>}</TD>
                  <TD>{t.server_id ? <Link className="hover:underline" to={`/servers/${t.server_id}`}>Server</Link> : <span className="text-xs text-muted-foreground">any (auto-create)</span>}</TD>
                  <TD className="tabular">{t.use_count}/{t.max_uses}</TD>
                  <TD className="text-xs">{formatDateTime(t.created_at)}</TD>
                  <TD className="text-xs">{formatDateTime(t.expires_at)}</TD>
                  <TD>
                    {t.revoked_at ? <Badge variant="destructive">revoked</Badge> : expired ? <Badge variant="outline">expired</Badge>
                      : exhausted ? <Badge variant="outline">used up</Badge> : <Badge variant="success">valid</Badge>}
                  </TD>
                  <TD className="text-right">
                    {!t.revoked_at && !expired && <Button variant="ghost" size="sm" onClick={() => setRevoking(t)}><Ban /> Revoke</Button>}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <TokenDialog open={open} onOpenChange={setOpen} />
      <ConfirmDialog open={Boolean(revoking)} onOpenChange={(o) => !o && setRevoking(null)} title="Revoke enrollment token?"
        description="Agents can no longer enroll with it. Already enrolled agents are not affected." destructive confirmLabel="Revoke"
        loading={revoke.isPending} onConfirm={() => revoking && revoke.mutate(revoking.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- agents

function AgentsTab() {
  const canManage = useCan("agents:manage");
  const q = useQuery({ queryKey: qk.agents, queryFn: agentsApi.list });
  const [revoking, setRevoking] = React.useState<Agent | null>(null);
  const revoke = useApiMutation({
    mutationFn: (id: string) => agentsApi.revoke(id), success: "Agent revoked", invalidate: [qk.agents, qk.resources], onSuccess: () => setRevoking(null),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Agents</CardTitle></CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No agents enrolled" description="Install the agent on a server with an enrollment token to collect metrics and logs." />
      ) : (
        <Table>
          <THead><TR><TH>Server</TH><TH>Hostname</TH><TH>Status</TH><TH>Version</TH><TH>Last seen</TH><TH>IP</TH><TH>Spool</TH><TH>Last error</TH><TH /></TR></THead>
          <TBody>
            {q.data.map((a) => (
              <TR key={a.id}>
                <TD><Link className="font-medium hover:underline" to={`/servers/${a.server_id}`}>{a.server_name ?? a.server_id.slice(0, 8)}</Link></TD>
                <TD className="font-mono text-xs">{a.reported_hostname || "—"}</TD>
                <TD><StatusBadge status={a.status} /></TD>
                <TD className="text-xs">{a.version || "—"}</TD>
                <TD><RelativeTime value={a.last_seen_at} /></TD>
                <TD className="font-mono text-xs">{a.last_ip || "—"}</TD>
                <TD className="tabular">{a.spool_depth}</TD>
                <TD className="max-w-[240px] truncate text-xs text-destructive" title={a.last_error}>{a.last_error}</TD>
                <TD className="text-right">
                  {canManage && a.status !== "revoked" && <Button variant="ghost" size="sm" onClick={() => setRevoking(a)}><Ban /> Revoke</Button>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <ConfirmDialog open={Boolean(revoking)} onOpenChange={(o) => !o && setRevoking(null)} title={`Revoke agent on “${revoking?.server_name ?? ""}”?`}
        description="The agent's credentials stop working immediately. Re-enroll with a new token to resume collection." destructive
        confirmLabel="Revoke agent" loading={revoke.isPending} onConfirm={() => revoking && revoke.mutate(revoking.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- ingestion

function IngestionTab() {
  const { orgId } = useAuth();
  const base = `${window.location.origin}${API_BASE}`;
  const now = "2026-01-01T12:00:00Z";
  const logs = `curl -X POST "${base}/logs/ingest" \\
  -H "Authorization: Bearer $EMONITOR_API_KEY" \\
  -H "X-Organization-ID: ${orgId ?? "<organization-id>"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "records": [{
      "ts": "${now}",
      "message": "payment failed: card declined",
      "severity": "error",
      "application": "checkout",
      "service": "payments",
      "host": "web-01",
      "trace_id": "4bf92f3577b34da6",
      "resource_id": "<optional resource uuid>",
      "attributes": {"order_id": "A-1001", "region": "eu"}
    }]
  }'`;
  const metrics = `curl -X POST "${base}/metrics/ingest" \\
  -H "Authorization: Bearer $EMONITOR_API_KEY" \\
  -H "X-Organization-ID: ${orgId ?? "<organization-id>"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "points": [{
      "resource_id": "<resource uuid>",
      "metric": "queue_depth",
      "instance": "orders",
      "value": 42,
      "ts": "${now}"
    }]
  }'`;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>HTTP log ingestion</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Send application logs with an API key holding the <code className="font-mono">logs:write</code> scope (IT admin role or higher).
            Up to 5000 records per request; severities emergency…debug (aliases such as warn/err/fatal are normalized). Timestamps older than
            7 days are replaced by the receive time. The daily log quota of the organization applies (HTTP 429 with Retry-After when exceeded).
          </p>
          <CodeBlock code={logs} />
          <p className="text-xs text-muted-foreground">Search the results in <Link className="text-primary hover:underline" to="/logs">Logs</Link>.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Custom metric ingestion</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Push metrics for any resource with an API key holding <code className="font-mono">metrics:write</code>. Up to 5000 points per
            request; metric names must match <code className="font-mono">^[a-z][a-z0-9_]{"{0,63}"}$</code>; timestamps must be within the
            last 24 hours (omit <code className="font-mono">ts</code> to use the receive time). Values must be finite numbers.
          </p>
          <CodeBlock code={metrics} />
          <p className="text-xs text-muted-foreground">Ingested metrics appear on the resource's Metrics tab and can drive metric-threshold alert rules.</p>
        </CardContent>
      </Card>
      <Card className="xl:col-span-2">
        <CardContent className="text-xs text-muted-foreground">
          All requests use <code className="font-mono">Authorization: Bearer &lt;api key&gt;</code>. An API key is bound to one organization; the
          <code className="mx-1 font-mono">X-Organization-ID</code> header is optional for keys but must match when sent. Create keys in the API keys tab.
        </CardContent>
      </Card>
    </div>
  );
}
