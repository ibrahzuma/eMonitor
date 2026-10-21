import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, KeyRound, Server } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { agentsApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { CodeBlock, PageHeader, TagInput } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useCan } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import { ENVIRONMENTS, type EnrollmentTokenCreated } from "@/types/api";
import { formatDateTime, humanize } from "@/utils/format";

function Step({ n, title, description, children }: { n: number; title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="items-start">
        <div className="flex items-start gap-3">
          <span aria-hidden className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{n}</span>
          <div>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription className="mt-1">{description}</CardDescription>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function TokenStep({ onCreated }: { onCreated: (t: EnrollmentTokenCreated) => void }) {
  const [desc, setDesc] = React.useState("");
  const [maxUses, setMaxUses] = React.useState("1");
  const [hours, setHours] = React.useState("24");
  const [env, setEnv] = React.useState("");
  const [tags, setTags] = React.useState<string[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const create = useApiMutation({
    mutationFn: async () => {
      const mu = Number(maxUses);
      const errs: Record<string, string> = {};
      if (!Number.isInteger(mu) || mu < 1 || mu > 1000) errs.max_uses = "1–1000";
      setErrors(errs);
      if (Object.keys(errs).length) throw new Error("Please fix the highlighted fields");
      return agentsApi.createToken({ description: desc, max_uses: mu, expires_in_hours: Number(hours), environment: env || null, tags });
    },
    invalidate: [qk.enrollmentTokens],
    success: "Enrollment token created",
    errorTitle: "Could not create token",
    onSuccess: onCreated,
    onError: (e) => setErrors((p) => ({ ...p, ...fieldErrorsOf(e) })),
  });
  return (
    <form noValidate className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <Field label="Description" htmlFor="ai-desc" className="sm:col-span-2" hint="So you remember what this token was for, e.g. “web servers rollout”">
        <Input id="ai-desc" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <Field label="How many servers will use it?" htmlFor="ai-uses" error={errors.max_uses} hint="Use 1 for a single server; a higher number for a fleet rollout">
        <Input id="ai-uses" type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
      </Field>
      <Field label="Valid for" htmlFor="ai-hours">
        <NativeSelect id="ai-hours" value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="1">1 hour</option>
          <option value="24">24 hours</option>
          <option value="168">7 days</option>
          <option value="720">30 days</option>
        </NativeSelect>
      </Field>
      <Field label="Environment for new servers" htmlFor="ai-env">
        <NativeSelect id="ai-env" value={env} onChange={(e) => setEnv(e.target.value)}>
          <option value="">Production (default)</option>
          {ENVIRONMENTS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Tags for new servers" htmlFor="ai-tags"><TagInput id="ai-tags" value={tags} onChange={setTags} /></Field>
      <div className="sm:col-span-2"><Button type="submit" loading={create.isPending}><KeyRound /> Create enrollment token</Button></div>
    </form>
  );
}

const CONFIG_EXAMPLE = `{
  "server_url": "<SERVER_URL>",
  "interval_seconds": 30,
  "services": ["ssh", "nginx", "postgresql"],
  "log_files": [
    {"path": "/var/log/nginx/error.log", "application": "nginx", "source": "nginx-error"},
    {"path": "/var/log/auth.log", "application": "sshd", "source": "auth"},
    {"path": "/var/log/myapp/app.json.log", "application": "myapp", "format": "json"}
  ]
}`;

const TROUBLESHOOTING: [string, string][] = [
  ["“Invalid or expired enrollment token”", "The token expired, was revoked or was already used up. Create a new token in step 1."],
  ["“python3 >= 3.10 is required”", "Install Python 3: Ubuntu/Debian `apt-get install -y python3`, RHEL/Rocky/Alma `dnf install -y python3`."],
  ["curl: (6) / (7) / (28) connection errors", "The server cannot reach the portal. Allow outbound HTTPS (port 443) to the portal address; check DNS and proxies."],
  ["SSL certificate problem", "The portal uses a private CA: re-run the install with --ca /path/to/ca.pem."],
  ["Server stays “Unknown” / no metrics", "Check `systemctl status emonitor-agent` and `journalctl -u emonitor-agent -n 50`. The agent's last error is also shown on the server's Agent tab."],
  ["Server shows “Unreachable”", "The agent stopped reporting for more than 3 minutes (configurable in System Settings). It resends buffered data when the connection returns."],
  ["Service shows as not running", "Use the exact systemd unit name (e.g. `ssh`, not `sshd`, on Ubuntu). Check with `systemctl is-active <name>`."],
];

export function AgentInstallPage() {
  const canManage = useCan("agents:manage");
  const info = useQuery({ queryKey: qk.agentInfo, queryFn: agentsApi.info });
  const [created, setCreated] = React.useState<EnrollmentTokenCreated | null>(null);
  if (info.isLoading) return <LoadingState />;
  if (info.isError || !info.data) return <ErrorState error={info.error} onRetry={() => void info.refetch()} />;
  const i = info.data;
  const command = created?.install_command ?? i.install_command_template;
  const manual = `# On a machine with access to the portal:\ncurl -fsSLO ${i.package_url}\n# Copy emonitor-agent-${i.agent_version}.tar.gz to the server, then on the server:\ntar -xzf emonitor-agent-${i.agent_version}.tar.gz\nsudo bash agent/scripts/install.sh --server ${i.server_url} --token <ENROLLMENT_TOKEN>`;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Install the monitoring agent"
        description="Collect CPU, memory, disk, network, service and log data from your Linux servers. One command per server; the server appears in the portal automatically."
        actions={<Badge variant="outline">Agent v{i.agent_version}</Badge>}
      />

      <Card>
        <CardHeader><CardTitle>Before you start</CardTitle></CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            {[
              "Linux with systemd (Ubuntu 22.04+, Debian 12+, RHEL / Rocky / Alma 9+)",
              "Python 3.10 or newer (pre-installed on the systems above)",
              "Root or sudo access on the server",
              <>Outbound HTTPS (port 443) to <code className="font-mono text-xs">{i.server_url}</code> — no inbound ports are opened</>,
            ].map((t, idx) => (
              <li key={idx} className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" aria-hidden /><span>{t}</span></li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Step n={1} title="Create an enrollment token"
        description="The token lets a server register itself. It is shown only once, expires, and can be limited to a number of servers.">
        {!canManage ? (
          <p className="text-sm text-muted-foreground">You need the IT Administrator or Organization Administrator role to create tokens. Ask an administrator for a token, then continue with step 2.</p>
        ) : created ? (
          <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium"><AlertTriangle className="size-4 text-amber-500" aria-hidden /> Copy the token now — it is shown only once.</p>
            <span className="text-xs text-muted-foreground">Valid until {formatDateTime(created.expires_at)} · usable by {created.max_uses} server(s)</span>
            <CodeBlock code={created.token} />
            <div><Button variant="outline" size="sm" onClick={() => setCreated(null)}>Create another token</Button></div>
          </div>
        ) : (
          <TokenStep onCreated={setCreated} />
        )}
      </Step>

      <Step n={2} title="Run the install command on the server"
        description={created ? "Your token is already filled in. Paste this into a terminal on the server (as a user with sudo)." : "Replace <ENROLLMENT_TOKEN> with the token from step 1 and paste it into a terminal on the server."}>
        <CodeBlock code={command} />
        <p className="text-xs text-muted-foreground">
          Optional: append <code className="font-mono">--services "ssh nginx postgresql"</code> to watch systemd services, or
          <code className="mx-1 font-mono">--ca /path/ca.pem</code> if the portal uses a private certificate authority. The script downloads the agent from
          this portal, verifies its SHA-256 checksum, creates an unprivileged <code className="font-mono">emonitor-agent</code> user and starts the
          <code className="mx-1 font-mono">emonitor-agent</code> systemd service. Running it again on an enrolled server is safe — it will not enroll twice.
        </p>
      </Step>

      <Step n={3} title="Check that it works" description="Within about a minute the server shows up as Healthy with live CPU, memory and disk values.">
        <CodeBlock code={"systemctl status emonitor-agent\nemonitor-agent status"} />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm"><Link to="/servers"><Server /> Open Servers</Link></Button>
          <Button asChild variant="outline" size="sm"><Link to="/integrations?tab=agents">See all agents</Link></Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Open the server to see charts (Metrics tab) and set alert thresholds (Settings tab). Defaults: CPU warning 80% / critical 95%,
          memory 85% / 95%, disk 80% / 90%.
        </p>
      </Step>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Monitor services and log files</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">Edit <code className="font-mono text-xs">/etc/emonitor-agent/agent.json</code> on the server, then run <code className="font-mono text-xs">sudo systemctl restart emonitor-agent</code>.
              The agent only reads what is listed here — the portal can never run commands on your server.</p>
            <CodeBlock code={CONFIG_EXAMPLE.replace("<SERVER_URL>", i.server_url)} />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle>Upgrade the agent</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p className="text-muted-foreground">Installs the latest version from this portal and keeps the existing configuration and credentials.</p>
              <CodeBlock code={i.upgrade_command} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Uninstall</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <CodeBlock code={"sudo emonitor-agent-uninstall          # keep config and credentials\nsudo emonitor-agent-uninstall --purge  # remove everything"} />
              <p className="text-muted-foreground">Then revoke the agent in <Link className="underline" to="/integrations?tab=agents">Integrations → Agents</Link> and delete the server if you no longer need its history.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Offline / manual installation</CardTitle>
          <Button asChild variant="outline" size="sm"><a href={i.package_url} download><Download /> Download agent package</a></Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">For servers where you prefer not to pipe a script into bash. The server still needs HTTPS access to the portal to send data.</p>
          <CodeBlock code={manual} />
          <p className="text-xs text-muted-foreground">SHA-256: <code className="break-all font-mono">{i.package_sha256}</code></p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Troubleshooting</CardTitle></CardHeader>
        <Table>
          <THead><TR><TH>Problem</TH><TH>What to do</TH></TR></THead>
          <TBody>
            {TROUBLESHOOTING.map(([p, s]) => <TR key={p}><TD className="font-medium align-top">{p}</TD><TD className="text-sm">{s}</TD></TR>)}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
