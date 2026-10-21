import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import * as React from "react";
import { errorMessage } from "@/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/cn";

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} aria-label={label} role="status" />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} aria-hidden />;
}

export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground", className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ title, description, icon, action, className }: {
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-10 text-center", className)}>
      <div className="text-muted-foreground [&_svg]:size-7">{icon ?? <Inbox aria-hidden />}</div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = "Could not load data", className }: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-2 px-4 py-8 text-center", className)}>
      <AlertTriangle className="size-6 text-destructive" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-lg break-words text-xs text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

/** Render loading / error / empty / content for a query-like object. */
export function QueryState<T>({ query, isEmpty, empty, children, loadingLabel }: {
  query: { data: T | undefined; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  loadingLabel?: string;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isLoading) return <LoadingState label={loadingLabel} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return <LoadingState label={loadingLabel} />;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return <>{children(query.data)}</>;
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="break-words">{errorMessage(error)}</span>
    </div>
  );
}
