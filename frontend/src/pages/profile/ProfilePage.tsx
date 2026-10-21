import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { CopyButton, PageHeader, RelativeTime } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import type { SessionInfo, TotpSetup, User } from "@/types/api";
import { browserTimeZone, formatDateTime, listTimeZones } from "@/utils/format";

function ProfileCard({ user }: { user: User }) {
  const { reloadMe } = useAuth();
  const zones = React.useMemo(() => listTimeZones(), []);
  const [name, setName] = React.useState(user.full_name);
  const [tz, setTz] = React.useState(user.timezone || "UTC");
  const [chat, setChat] = React.useState(user.telegram_chat_id ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    setName(user.full_name);
    setTz(user.timezone || "UTC");
    setChat(user.telegram_chat_id ?? "");
  }, [user]);
  const save = useApiMutation({
    mutationFn: () => authApi.updateMe({ full_name: name.trim(), timezone: tz, telegram_chat_id: chat.trim() }),
    success: "Profile updated",
    onSuccess: () => void reloadMe(),
    onError: (e) => setErrors(fieldErrorsOf(e)),
  });
  return (
    <Card>
      <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
      <CardContent>
        <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Email" htmlFor="profile-email" hint="Contact an administrator to change your email">
            <Input id="profile-email" value={user.email} disabled />
          </Field>
          <Field label="Full name" htmlFor="profile-name" error={errors.full_name}>
            <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Time zone" htmlFor="profile-tz" error={errors.timezone} hint={`Timestamps are displayed in this zone (browser: ${browserTimeZone()})`}>
            <NativeSelect id="profile-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
              {!zones.includes(tz) && <option value={tz}>{tz}</option>}
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Telegram chat ID" htmlFor="profile-chat" error={errors.telegram_chat_id} hint="For personal Telegram notifications">
            <Input id="profile-chat" value={chat} onChange={(e) => setChat(e.target.value)} maxLength={64} />
          </Field>
          <div><Button type="submit" loading={save.isPending}>Save profile</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const change = useApiMutation({
    mutationFn: () => authApi.changePassword(current, next),
    errorTitle: false,
    onSuccess: (m) => { setDone(m.message); setCurrent(""); setNext(""); setConfirm(""); },
    onError: (e) => setFormError(e),
  });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDone(null);
    setFormError(null);
    const fe: Record<string, string> = {};
    if (!current) fe.current = "Enter your current password";
    if (next.length < 12) fe.next = "Use at least 12 characters";
    if (next !== confirm) fe.confirm = "Passwords do not match";
    setErrors(fe);
    if (!Object.keys(fe).length) change.mutate();
  };
  return (
    <Card>
      <CardHeader><CardTitle>Change password</CardTitle></CardHeader>
      <CardContent>
        <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
          {formError !== null && <InlineError error={formError} />}
          {done && <p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{done}</p>}
          <Field label="Current password" htmlFor="pw-current" error={errors.current} required>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" htmlFor="pw-new" error={errors.next} required hint="At least 12 characters; mix letters, digits and symbols">
            <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password" htmlFor="pw-confirm" error={errors.confirm} required>
            <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <div><Button type="submit" loading={change.isPending}><KeyRound /> Change password</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactorCard({ user }: { user: User }) {
  const { reloadMe } = useAuth();
  const [setup, setSetup] = React.useState<TotpSetup | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [formError, setFormError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!setup) {
      setQr(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(setup.otpauth_url, { margin: 1, width: 192 })
      .then((url) => { if (!cancelled) setQr(url); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [setup]);

  const start = useApiMutation({
    mutationFn: () => authApi.totpSetup(),
    errorTitle: "Could not start 2FA setup",
    onSuccess: (s) => { setSetup(s); setCode(""); setFormError(null); },
  });
  const enable = useApiMutation({
    mutationFn: () => authApi.totpEnable(code.trim()),
    success: "Two-factor authentication enabled",
    errorTitle: false,
    onSuccess: () => { setSetup(null); setCode(""); void reloadMe(); },
    onError: (e) => setFormError(e),
  });
  const disable = useApiMutation({
    mutationFn: () => authApi.totpDisable(code.trim(), password),
    success: "Two-factor authentication disabled",
    errorTitle: false,
    onSuccess: () => { setCode(""); setPassword(""); void reloadMe(); },
    onError: (e) => setFormError(e),
  });

  const validCode = /^\d{6,10}$/.test(code.trim());

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        {user.totp_enabled ? <Badge variant="success"><ShieldCheck className="size-3" /> Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {formError !== null && <InlineError error={formError} />}
        {user.totp_enabled ? (
          <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); setFormError(null); disable.mutate(); }}>
            <p className="text-sm text-muted-foreground">To disable two-factor authentication confirm your password and a current code.</p>
            <Field label="Password" htmlFor="tfa-disable-pw" required>
              <Input id="tfa-disable-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Verification code" htmlFor="tfa-disable-code" required>
              <Input id="tfa-disable-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} />
            </Field>
            <div><Button type="submit" variant="destructive" disabled={!validCode || !password} loading={disable.isPending}>Disable 2FA</Button></div>
          </form>
        ) : !setup ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Protect your account with a time-based one-time password from an authenticator app.</p>
            <div><Button onClick={() => start.mutate()} loading={start.isPending}>Set up two-factor authentication</Button></div>
          </div>
        ) : (
          <form noValidate className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); setFormError(null); enable.mutate(); }}>
            <p className="text-sm">1. Scan this QR code with your authenticator app.</p>
            <div className="flex flex-wrap items-start gap-4">
              {qr ? (
                <img src={qr} alt="QR code for two-factor authentication setup" width={192} height={192} className="rounded border bg-white p-1" />
              ) : (
                <div className="flex size-48 items-center justify-center rounded border text-xs text-muted-foreground">Generating QR code…</div>
              )}
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">Or enter this secret manually:</span>
                <code data-testid="totp-secret" className="break-all rounded bg-muted px-2 py-1 font-mono text-sm">{setup.secret}</code>
                <div><CopyButton value={setup.secret} label="Copy secret" /></div>
              </div>
            </div>
            <p className="text-sm">2. Enter the 6-digit code shown by the app.</p>
            <Field label="Verification code" htmlFor="tfa-enable-code" required>
              <Input id="tfa-enable-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} className="max-w-[200px]" />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={!validCode} loading={enable.isPending}>Enable 2FA</Button>
              <Button variant="outline" onClick={() => { setSetup(null); setCode(""); }}>Cancel</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: qk.sessions, queryFn: authApi.sessions });
  const [revoking, setRevoking] = React.useState<SessionInfo | null>(null);
  const revoke = useApiMutation({
    mutationFn: (s: SessionInfo) => authApi.revokeSession(s.id),
    invalidate: [qk.sessions],
    success: "Session revoked",
    onSuccess: (_m, s) => {
      setRevoking(null);
      if (s.current) void logout().then(() => navigate("/login"));
    },
  });
  return (
    <Card>
      <CardHeader><CardTitle>Active sessions</CardTitle></CardHeader>
      {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyState title="No active sessions" />
      ) : (
        <Table>
          <THead><TR><TH>Device</TH><TH>IP</TH><TH>Signed in</TH><TH>Last used</TH><TH>Expires</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {q.data.map((s) => (
              <TR key={s.id}>
                <TD className="max-w-[320px]">
                  <span className="line-clamp-2 text-xs" title={s.user_agent}>{s.user_agent || "Unknown client"}</span>
                  {s.current && <Badge variant="info" className="mt-1">This device</Badge>}
                </TD>
                <TD className="font-mono text-xs">{s.ip_address || "—"}</TD>
                <TD className="text-xs">{formatDateTime(s.created_at)}</TD>
                <TD><RelativeTime value={s.last_used_at} /></TD>
                <TD className="text-xs">{formatDateTime(s.expires_at)}</TD>
                <TD className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(s)}><LogOut /> Revoke</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <ConfirmDialog open={Boolean(revoking)} onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking?.current ? "Sign out of this device?" : "Revoke session?"}
        description={revoking?.current ? "This is your current session — revoking it signs you out immediately." : "The device will be signed out on its next request."}
        destructive confirmLabel="Revoke" loading={revoke.isPending} onConfirm={() => revoking && revoke.mutate(revoking)} />
    </Card>
  );
}

export function ProfilePage() {
  const { user } = useAuth();
  if (!user) return <LoadingState />;
  return (
    <div>
      <PageHeader title="Profile & security" description="Your account details, password, two-factor authentication and sessions." />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ProfileCard user={user} />
        <PasswordCard />
        <TwoFactorCard user={user} />
        <SessionsCard />
      </div>
    </div>
  );
}
