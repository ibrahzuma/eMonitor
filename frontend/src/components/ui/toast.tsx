import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/utils/cn";

export type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

type ToastFn = (t: Omit<ToastItem, "id">) => void;

const ToastContext = React.createContext<ToastFn | null>(null);

let externalPush: ToastFn | null = null;
/** Push a toast from outside React (e.g. the global QueryClient error handler). */
export function pushToast(t: Omit<ToastItem, "id">): void {
  externalPush?.(t);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const push = React.useCallback<ToastFn>((t) => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-4), { ...t, id }]);
    window.setTimeout(() => dismiss(id), t.kind === "error" ? 8000 : 4500);
  }, [dismiss]);

  React.useEffect(() => {
    externalPush = push;
    return () => {
      externalPush = null;
    };
  }, [push]);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed bottom-3 right-3 z-[100] flex w-[min(92vw,380px)] flex-col gap-2"
      >
        {items.map((t) => {
          const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? AlertTriangle : Info;
          return (
            <div
              key={t.id}
              role={t.kind === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex items-start gap-2.5 rounded-md border bg-popover p-3 text-sm shadow-lg",
                t.kind === "error" && "border-destructive/40",
              )}
            >
              <Icon className={cn("mt-0.5 size-4 shrink-0", t.kind === "success" && "text-emerald-500",
                t.kind === "error" && "text-destructive", t.kind === "info" && "text-sky-500")} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 break-words text-xs text-muted-foreground">{t.description}</p>}
              </div>
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = React.useContext(ToastContext);
  return React.useMemo(() => {
    const fn: ToastFn = push ?? (() => undefined);
    return {
      success: (title: string, description?: string) => fn({ kind: "success", title, description }),
      error: (title: string, description?: string) => fn({ kind: "error", title, description }),
      info: (title: string, description?: string) => fn({ kind: "info", title, description }),
    };
  }, [push]);
}
