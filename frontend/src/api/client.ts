import type { ApiErrorBody, ApiErrorDetail, TokenResponse } from "@/types/api";

/** Base path of the API. Relative by default so the SPA works behind nginx / the Vite proxy. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? "/api/v1").replace(/\/+$/, "");

const ORG_STORAGE_KEY = "emonitor.org";
export const CSRF_COOKIE = "emonitor_csrf";

// ---------------------------------------------------------------- errors

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, details: unknown = null, requestId: string | null = null,
    retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }

  /** Validation details as a list of {loc,msg} (422 responses). */
  get validationDetails(): ApiErrorDetail[] {
    if (!Array.isArray(this.details)) return [];
    return this.details.filter((d): d is ApiErrorDetail => typeof d === "object" && d !== null && "msg" in d);
  }

  /**
   * Map 422 details to form field names. `loc` looks like ["body", "config", "url"]; the leading "body"/"query"
   * is dropped and the remaining path is joined with dots ("config.url"). The last segment is also registered
   * so simple forms can look up "url".
   */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.validationDetails) {
      const loc = (d.loc ?? []).filter((p) => p !== "body" && p !== "query" && p !== "path");
      if (!loc.length || !d.msg) continue;
      const msg = d.msg.replace(/^Value error, /, "");
      const full = loc.join(".");
      out[full] ??= msg;
      const last = String(loc[loc.length - 1]);
      out[last] ??= msg;
    }
    return out;
  }

  /** Human readable description including validation messages. */
  describe(): string {
    const v = this.validationDetails;
    if (v.length) {
      const parts = v.slice(0, 4).map((d) => {
        const loc = (d.loc ?? []).filter((p) => p !== "body" && p !== "query").join(".");
        return loc ? `${loc}: ${d.msg ?? ""}` : (d.msg ?? "");
      });
      return `${this.message} — ${parts.join("; ")}`;
    }
    if (this.status === 429 && this.retryAfter) return `${this.message}. Retry in ${this.retryAfter}s.`;
    return this.message;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.describe();
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

// ---------------------------------------------------------------- session state (in memory)

type Listener = () => void;

let accessToken: string | null = null;
const tokenListeners = new Set<Listener>();

export const tokenStore = {
  get: (): string | null => accessToken,
  set: (token: string | null): void => {
    accessToken = token;
    tokenListeners.forEach((l) => l());
  },
  subscribe: (l: Listener): (() => void) => {
    tokenListeners.add(l);
    return () => tokenListeners.delete(l);
  },
};

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

let currentOrg: string | null = typeof window !== "undefined" ? safeStorageGet(ORG_STORAGE_KEY) : null;

export const orgStore = {
  get: (): string | null => currentOrg,
  set: (orgId: string | null): void => {
    currentOrg = orgId;
    safeStorageSet(ORG_STORAGE_KEY, orgId);
  },
};

let authFailureHandler: (() => void) | null = null;
/** Registered by the AuthProvider: called when a request is unauthenticated and refreshing failed. */
export function onAuthFailure(handler: (() => void) | null): void {
  authFailureHandler = handler;
}

export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// ---------------------------------------------------------------- URL helpers

export type QueryValue = string | number | boolean | null | undefined | (string | number | boolean)[];
export type Query = Record<string, QueryValue>;

export function buildQuery(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((item) => p.append(k, String(item)));
    else p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function apiUrl(path: string, query?: Query): string {
  const rel = `${API_BASE}${path}${buildQuery(query)}`;
  if (/^https?:\/\//.test(rel)) return rel;
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  return new URL(rel, origin).toString();
}

export function wsUrl(): string {
  const http = apiUrl("/ws");
  return http.replace(/^http/, "ws");
}

// ---------------------------------------------------------------- refresh (deduplicated)

let refreshPromise: Promise<TokenResponse | null> | null = null;

async function doRefresh(): Promise<TokenResponse | null> {
  const csrf = readCookie(CSRF_COOKIE);
  if (!csrf) return null;
  try {
    const res = await fetch(apiUrl("/auth/refresh"), {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Token": csrf, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as TokenResponse;
    if (!data.access_token) return null;
    tokenStore.set(data.access_token);
    return data;
  } catch {
    return null;
  }
}

/** Refresh the access token using the HttpOnly refresh cookie. Concurrent callers share one request. */
export function refreshSession(): Promise<TokenResponse | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// ---------------------------------------------------------------- requests

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** Do not attach the bearer token / org header (login, forgot-password ...). */
  anonymous?: boolean;
  /** Do not attempt a token refresh on 401. */
  noRefresh?: boolean;
  /** Send cookies (auth endpoints using the refresh/CSRF cookies). */
  withCredentials?: boolean;
  /** Override the organization header (null = omit). */
  organizationId?: string | null;
}

function buildHeaders(opts: RequestOptions): Headers {
  const h = new Headers({ Accept: "application/json", ...(opts.headers ?? {}) });
  if (opts.body !== undefined) h.set("Content-Type", "application/json");
  if (!opts.anonymous) {
    const token = tokenStore.get();
    if (token) h.set("Authorization", `Bearer ${token}`);
    const org = opts.organizationId === undefined ? orgStore.get() : opts.organizationId;
    if (org) h.set("X-Organization-ID", org);
  }
  return h;
}

async function toApiError(res: Response): Promise<ApiError> {
  const retry = res.headers.get("Retry-After");
  const retryAfter = retry ? Number(retry) || null : null;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const err = (body as Partial<ApiErrorBody> | null)?.error;
  if (err && typeof err === "object") {
    return new ApiError(res.status, err.code ?? "error", err.message ?? res.statusText, err.details ?? null,
      err.request_id ?? null, retryAfter);
  }
  const fallback = res.status >= 500 ? "Server error" : res.statusText || `HTTP ${res.status}`;
  return new ApiError(res.status, "http_error", fallback, null, null, retryAfter);
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  return fetch(apiUrl(path, opts.query), {
    method: opts.method ?? "GET",
    headers: buildHeaders(opts),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: opts.withCredentials ? "include" : "same-origin",
  });
}

/** Perform a request, refreshing once on 401. Returns the raw response (ok). */
export async function rawRequest(path: string, opts: RequestOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await send(path, opts);
  } catch (e) {
    throw new ApiError(0, "network_error", e instanceof Error ? `Network error: ${e.message}` : "Network error");
  }
  if (res.status === 401 && !opts.anonymous && !opts.noRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      try {
        res = await send(path, opts);
      } catch (e) {
        throw new ApiError(0, "network_error", e instanceof Error ? `Network error: ${e.message}` : "Network error");
      }
    }
    if (res.status === 401) {
      const err = await toApiError(res);
      tokenStore.set(null);
      authFailureHandler?.();
      throw err;
    }
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Query, opts: RequestOptions = {}) => request<T>(path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts: RequestOptions = {}) =>
    request<T>(path, { ...opts, method: "POST", body: body ?? {} }),
  put: <T>(path: string, body: unknown, opts: RequestOptions = {}) => request<T>(path, { ...opts, method: "PUT", body }),
  patch: <T>(path: string, body: unknown, opts: RequestOptions = {}) =>
    request<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T>(path: string, opts: RequestOptions = {}) => request<T>(path, { ...opts, method: "DELETE" }),
};

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m?.[1] ? decodeURIComponent(m[1]) : fallback;
}

/** Download a file (CSV/PDF) with the auth header attached, then trigger a browser save. */
export async function downloadFile(path: string, query: Query | undefined, fallbackName: string): Promise<string> {
  const res = await rawRequest(path, { query, headers: { Accept: "*/*" } });
  const blob = await res.blob();
  const name = filenameFrom(res, fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
