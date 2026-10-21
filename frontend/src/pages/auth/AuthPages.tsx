import * as React from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, errorMessage } from "@/api/client";
import { authApi } from "@/api/endpoints";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { InlineError } from "@/components/ui/states";
import { useAuth } from "@/features/auth/AuthProvider";

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#0f172a" />
            <path d="M5 17h5l3-7 5 13 3-6h6" fill="none" stroke="#22c55e" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">eMonitor</span>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-base font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login, completeMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [mfaToken, setMfaToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const codeRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (mfaToken) codeRef.current?.focus();
  }, [mfaToken]);

  const handleError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 422) {
      setFieldErrors(e.fieldErrors());
      setError(e.validationDetails.length ? "Please correct the highlighted fields." : e.message);
    } else if (e instanceof ApiError && e.status === 429) {
      setError(`Too many attempts. Try again${e.retryAfter ? ` in ${e.retryAfter} seconds` : " later"}.`);
    } else {
      setError(errorMessage(e));
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    const fe: Record<string, string> = {};
    if (!email.trim()) fe.email = "Email is required";
    if (!password) fe.password = "Password is required";
    if (Object.keys(fe).length) {
      setFieldErrors(fe);
      return;
    }
    setBusy(true);
    try {
      const res = await login(email.trim(), password);
      if (res.kind === "mfa") {
        setMfaToken(res.mfaToken);
      } else {
        navigate(from, { replace: true });
      }
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaToken) return;
    setError(null);
    if (!/^\d{6,10}$/.test(code.trim())) {
      setFieldErrors({ code: "Enter the 6-digit code from your authenticator app" });
      return;
    }
    setBusy(true);
    try {
      await completeMfa(mfaToken, code.trim());
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && /expired/i.test(err.message)) {
        setMfaToken(null);
        setCode("");
      }
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  if (mfaToken) {
    return (
      <AuthShell title="Two-factor authentication" subtitle="Enter the verification code from your authenticator app.">
        <form onSubmit={submitMfa} className="flex flex-col gap-4" noValidate>
          {error && <InlineError error={new Error(error)} />}
          <Field label="Verification code" htmlFor="mfa-code" error={fieldErrors.code} required>
            <Input ref={codeRef} id="mfa-code" inputMode="numeric" autoComplete="one-time-code" maxLength={10}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">Verify</Button>
          <button type="button" className="text-xs text-muted-foreground hover:underline"
            onClick={() => { setMfaToken(null); setCode(""); setError(null); }}>
            Back to sign in
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in" subtitle="Monitor your infrastructure in real time.">
      <form onSubmit={submitPassword} className="flex flex-col gap-4" noValidate>
        {error && <InlineError error={new Error(error)} />}
        <Field label="Email" htmlFor="login-email" error={fieldErrors.email} required>
          <Input id="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="login-password" error={fieldErrors.password} required>
          <Input id="login-password" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" loading={busy} className="w-full">Sign in</Button>
        <Link to="/forgot-password" className="text-center text-xs text-primary hover:underline">Forgot your password?</Link>
      </form>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [done, setDone] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError(new Error("Email is required"));
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.forgotPassword(email.trim());
      setDone(res.message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new password.">
      {done ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-sm">{done}</p>
          <Link to="/login" className="text-sm text-primary hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <InlineError error={error} />
          <Field label="Email" htmlFor="forgot-email" required>
            <Input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">Send reset link</Button>
          <Link to="/login" className="text-center text-xs text-muted-foreground hover:underline">Back to sign in</Link>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const [error, setError] = React.useState<unknown>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw !== pw2) {
      setError(new Error("Passwords do not match"));
      return;
    }
    setBusy(true);
    try {
      const res = await authApi.resetPassword(token, pw);
      setDone(res.message);
      window.setTimeout(() => navigate("/login"), 2500);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!token) {
    return (
      <AuthShell title="Invalid reset link">
        <p className="text-sm text-muted-foreground">The reset link is missing its token. Request a new one.</p>
        <Link to="/forgot-password" className="mt-4 inline-block text-sm text-primary hover:underline">Request a new link</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password" subtitle="Use at least 12 characters with a mix of character types.">
      {done ? (
        <p role="status" className="text-sm">{done} Redirecting to sign in…</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <InlineError error={error} />
          <Field label="New password" htmlFor="reset-pw" required>
            <Input id="reset-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Confirm password" htmlFor="reset-pw2" required>
            <Input id="reset-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">Update password</Button>
        </form>
      )}
    </AuthShell>
  );
}
