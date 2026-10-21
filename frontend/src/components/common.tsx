import { Check, ChevronLeft, ChevronRight, Copy, X } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/menus";
import type { IncidentStatus } from "@/types/api";
import { cn } from "@/utils/cn";
import { formatDateTime, formatRelative, humanize } from "@/utils/format";
import { INCIDENT_STATUS_STYLES, severityStyle, statusStyle } from "@/utils/status";

// ---------------------------------------------------------------- status & severity badges

export function StatusDot({ status, className }: { status: string | null | undefined; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", statusStyle(status).dot, className)} aria-hidden />;
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const s = statusStyle(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", s.badge, className)}>
      <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden />
      {humanize(status ?? "unknown")}
    </span>
  );
}

export function SeverityBadge({ severity, className }: { severity: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset", severityStyle(severity).badge, className)}>
      {severity}
    </span>
  );
}

export function IncidentStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
      INCIDENT_STATUS_STYLES[status as IncidentStatus] ?? "bg-muted text-muted-foreground ring-border")}>
      {humanize(status)}
    </span>
  );
}

// ---------------------------------------------------------------- time

export function RelativeTime({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <Tooltip content={formatDateTime(value, { seconds: true })}>
      <time dateTime={value} className={cn("whitespace-nowrap", className)} tabIndex={0}>
        {formatRelative(value)}
      </time>
    </Tooltip>
  );
}

// ---------------------------------------------------------------- page header

export function PageHeader({ title, description, actions, children }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- copy

export function CopyButton({ value, label = "Copy", size = "sm" }: { value: string; label?: string; size?: "sm" | "icon-sm" }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="outline" size={size} onClick={() => void copy()} aria-label={label}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {size === "sm" && (copied ? "Copied" : label)}
    </Button>
  );
}

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn("relative rounded-md border bg-muted/60", className)}>
      <pre className="scrollbar-thin overflow-x-auto p-3 pr-20 font-mono text-xs leading-relaxed"><code>{code}</code></pre>
      <div className="absolute right-2 top-2">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  return (
    <pre className={cn("scrollbar-thin max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed", className)}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------- pagination

export function Pagination({ page, pageSize, total, onPage }: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span className="tabular">{from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="tabular px-1">Page {page} / {pages}</span>
        <Button variant="outline" size="icon-sm" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- tag input

export function TagInput({ id, value, onChange, placeholder = "Add and press Enter", ariaLabel }: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const add = (raw: string) => {
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange(Array.from(new Set([...value, ...parts])));
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-card px-1.5 py-1 focus-within:outline-2 focus-within:outline-ring">
      {value.map((t) => (
        <Badge key={t} variant="secondary" className="gap-0.5 pr-0.5">
          {t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}
            className="rounded p-0.5 hover:bg-accent">
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        id={id}
        aria-label={ariaLabel}
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
        className="h-6 min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ---------------------------------------------------------------- key/value editor

export function KeyValueEditor({ idPrefix, value, onChange, keyPlaceholder = "Name", valuePlaceholder = "Value", secret }: {
  idPrefix: string;
  value: [string, string][];
  onChange: (v: [string, string][]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  secret?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input aria-label={`${keyPlaceholder} ${i + 1}`} id={`${idPrefix}-k-${i}`} value={k} placeholder={keyPlaceholder}
            onChange={(e) => onChange(value.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
          <Input aria-label={`${valuePlaceholder} ${i + 1}`} id={`${idPrefix}-v-${i}`} value={v} placeholder={valuePlaceholder}
            type={secret ? "password" : "text"} autoComplete="off"
            onChange={(e) => onChange(value.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} />
          <Button variant="ghost" size="icon-sm" aria-label={`Remove row ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => onChange([...value, ["", ""]])}>Add</Button>
      </div>
    </div>
  );
}

export function pairsToRecord(pairs: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) if (k.trim()) out[k.trim()] = v;
  return out;
}

export function recordToPairs(rec: unknown): [string, string][] {
  if (!rec || typeof rec !== "object") return [];
  return Object.entries(rec as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]);
}

// ---------------------------------------------------------------- stat tile

export function Stat({ label, value, sub, tone, to }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "good" | "warn" | "bad" | "purple" | "info";
  to?: string;
}) {
  const toneCls = {
    default: "",
    good: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    bad: "text-red-600 dark:text-red-400",
    purple: "text-fuchsia-600 dark:text-fuchsia-400",
    info: "text-sky-600 dark:text-sky-400",
  }[tone ?? "default"];
  const inner = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn("tabular text-xl font-semibold leading-tight", toneCls)}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </>
  );
  const cls = "flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left shadow-xs";
  if (to) {
    return (
      <Link to={to} className={cn(cls, "hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring")}>
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}

export function DefinitionList({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v === "" || v === null || v === undefined ? "—" : v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
