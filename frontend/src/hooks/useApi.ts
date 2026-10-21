import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError, errorMessage } from "@/api/client";
import { useToast } from "@/components/ui/toast";

interface MutationOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Query key prefixes to invalidate after success. */
  invalidate?: QueryKey[];
  success?: string | ((data: TData, vars: TVars) => string | null);
  /** Toast title for errors. Set to false to let the caller render the error inline. */
  errorTitle?: string | false;
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (err: unknown) => void;
}

/** useMutation with standard toast feedback and cache invalidation. */
export function useApiMutation<TData, TVars = void>(opts: MutationOptions<TData, TVars>) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TData, unknown, TVars>({
    mutationFn: opts.mutationFn,
    onSuccess: (data, vars) => {
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      const msg = typeof opts.success === "function" ? opts.success(data, vars) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(data, vars);
    },
    onError: (err) => {
      if (opts.errorTitle !== false) toast.error(opts.errorTitle ?? "Request failed", errorMessage(err));
      opts.onError?.(err);
    },
  });
}

/** Field errors from a 422 ApiError, keyed by field name. */
export function fieldErrorsOf(err: unknown): Record<string, string> {
  return err instanceof ApiError && err.status === 422 ? err.fieldErrors() : {};
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Read/write URL search params as filter state (keeps filters shareable and drill-down friendly). */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  const values = React.useMemo(() => {
    const out = {} as Record<K, string[]>;
    for (const k of keys) out[k] = params.getAll(k);
    return out;
  }, [params, keys]);
  const get = React.useCallback((k: K) => params.get(k) ?? "", [params]);
  const set = React.useCallback((patch: Partial<Record<K, string | string[] | null>>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch) as [K, string | string[] | null | undefined][]) {
        next.delete(k);
        if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
        else if (v) next.set(k, v);
      }
      if (!("page" in patch)) next.delete("page");
      return next;
    }, { replace: true });
  }, [setParams]);
  return { values, get, set };
}
