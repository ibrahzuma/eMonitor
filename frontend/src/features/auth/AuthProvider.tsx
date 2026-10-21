import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { onAuthFailure, orgStore, refreshSession, tokenStore } from "@/api/client";
import { authApi } from "@/api/endpoints";
import type { Me, Membership, Permission, TokenResponse, User } from "@/types/api";
import { setDisplayTimeZone } from "@/utils/format";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export type LoginResult = { kind: "ok" } | { kind: "mfa"; mfaToken: string };

interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  user: User | null;
  orgId: string | null;
  membership: Membership | null;
  permissions: Permission[];
  can: (p: Permission) => boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => void;
  reloadMe: () => Promise<Me | null>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

function pickOrg(me: Me, preferred: string | null): string | null {
  if (preferred && me.memberships.some((m) => m.organization_id === preferred)) return preferred;
  return me.memberships[0]?.organization_id ?? null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<AuthStatus>("loading");
  const [me, setMe] = React.useState<Me | null>(null);
  const [orgId, setOrgId] = React.useState<string | null>(orgStore.get());

  const applyMe = React.useCallback((data: Me) => {
    setMe(data);
    setDisplayTimeZone(data.user.timezone);
    const org = pickOrg(data, orgStore.get());
    orgStore.set(org);
    setOrgId(org);
    setStatus("authenticated");
  }, []);

  const reloadMe = React.useCallback(async (): Promise<Me | null> => {
    try {
      const data = await authApi.me();
      applyMe(data);
      return data;
    } catch {
      return null;
    }
  }, [applyMe]);

  const resetToAnonymous = React.useCallback(() => {
    tokenStore.set(null);
    setMe(null);
    setStatus("anonymous");
    queryClient.clear();
  }, [queryClient]);

  // Restore the session from the refresh cookie on first load.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const refreshed = await refreshSession();
      if (cancelled) return;
      if (!refreshed) {
        setStatus("anonymous");
        return;
      }
      const data = await reloadMe();
      if (!cancelled && !data) setStatus("anonymous");
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadMe]);

  React.useEffect(() => {
    onAuthFailure(() => resetToAnonymous());
    return () => onAuthFailure(null);
  }, [resetToAnonymous]);

  const finishLogin = React.useCallback(async (res: TokenResponse) => {
    if (!res.access_token) throw new Error("Login did not return an access token");
    tokenStore.set(res.access_token);
    queryClient.clear();
    const data = await authApi.me();
    applyMe(data);
  }, [applyMe, queryClient]);

  const login = React.useCallback(async (email: string, password: string): Promise<LoginResult> => {
    const res = await authApi.login(email, password);
    if (res.mfa_required && res.mfa_token) return { kind: "mfa", mfaToken: res.mfa_token };
    await finishLogin(res);
    return { kind: "ok" };
  }, [finishLogin]);

  const completeMfa = React.useCallback(async (mfaToken: string, code: string) => {
    const res = await authApi.loginMfa(mfaToken, code);
    await finishLogin(res);
  }, [finishLogin]);

  const logout = React.useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the session is cleared locally regardless */
    }
    resetToAnonymous();
  }, [resetToAnonymous]);

  const switchOrg = React.useCallback((id: string) => {
    orgStore.set(id);
    setOrgId(id);
    queryClient.clear();
  }, [queryClient]);

  const value = React.useMemo<AuthContextValue>(() => {
    const permissions = (orgId && me?.permissions[orgId]) || [];
    const membership = me?.memberships.find((m) => m.organization_id === orgId) ?? null;
    return {
      status,
      me,
      user: me?.user ?? null,
      orgId,
      membership,
      permissions,
      can: (p: Permission) => permissions.includes(p),
      login,
      completeMfa,
      logout,
      switchOrg,
      reloadMe,
    };
  }, [status, me, orgId, login, completeMfa, logout, switchOrg, reloadMe]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function useCan(p: Permission): boolean {
  return useAuth().can(p);
}

/** Render children only when the current user holds the permission in the selected organization. */
export function Can({ perm, children, fallback = null }: { perm: Permission; children: React.ReactNode; fallback?: React.ReactNode }) {
  return <>{useCan(perm) ? children : fallback}</>;
}
