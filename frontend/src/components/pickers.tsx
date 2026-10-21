import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, X } from "lucide-react";
import * as React from "react";
import { groupsApi, notificationsApi, resourcesApi, teamsApi, usersApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { StatusDot } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menus";
import { useDebounced } from "@/hooks/useApi";
import type { Resource } from "@/types/api";
import { cn } from "@/utils/cn";
import { KIND_LABELS } from "@/utils/status";

export interface Option {
  value: string;
  label: string;
  hint?: string;
  status?: string;
}

/** Accessible multi-select: a button opening a searchable checkbox list. */
export function MultiSelect({ id, options, value, onChange, placeholder = "Select…", loading, onSearch, ariaLabel,
  emptyText = "No options" }: {
  id?: string;
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  loading?: boolean;
  onSearch?: (q: string) => void;
  ariaLabel?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const known = React.useRef(new Map<string, Option>());
  options.forEach((o) => known.current.set(o.value, o));
  const filtered = onSearch ? options : options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="flex flex-col gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button id={id} type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
            className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-card px-2.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring">
            <span className={cn("truncate", !value.length && "text-muted-foreground")}>
              {value.length ? `${value.length} selected` : placeholder}
            </span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(92vw,360px)] p-0">
          <div className="border-b p-2">
            <Input autoFocus placeholder="Search…" aria-label="Search options" value={q}
              onChange={(e) => { setQ(e.target.value); onSearch?.(e.target.value); }} />
          </div>
          <ul role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto p-1">
            {loading && <li className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</li>}
            {!loading && !filtered.length && <li className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</li>}
            {filtered.map((o) => {
              const sel = value.includes(o.value);
              return (
                <li key={o.value} role="option" aria-selected={sel}>
                  <button type="button" onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                    <span className={cn("flex size-4 items-center justify-center rounded-[3px] border", sel && "border-primary bg-primary text-primary-foreground")}>
                      {sel && <Check className="size-3" aria-hidden />}
                    </span>
                    {o.status && <StatusDot status={o.status} />}
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="gap-0.5 pr-0.5">
              {known.current.get(v)?.label ?? v.slice(0, 8)}
              <button type="button" aria-label={`Remove ${known.current.get(v)?.label ?? v}`} onClick={() => toggle(v)}
                className="rounded p-0.5 hover:bg-accent">
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function resourceOption(r: Resource): Option {
  return { value: r.id, label: r.name, hint: KIND_LABELS[r.kind] ?? r.kind, status: r.status };
}

/** Search-as-you-type resource multi picker backed by GET /resources?q=. */
export function ResourcePicker({ id, value, onChange, kinds, ariaLabel }: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  kinds?: string[];
  ariaLabel?: string;
}) {
  const [q, setQ] = React.useState("");
  const dq = useDebounced(q, 250);
  const query = useQuery({
    queryKey: qk.resourceList("picker", { q: dq, kind: kinds ?? [] }),
    queryFn: () => resourcesApi.list({ q: dq, kind: kinds, page_size: 50 }),
  });
  return (
    <MultiSelect id={id} ariaLabel={ariaLabel} value={value} onChange={onChange} loading={query.isLoading}
      options={(query.data?.items ?? []).map(resourceOption)} onSearch={setQ} placeholder="Select resources…"
      emptyText="No matching resources" />
  );
}

/** Single resource select (native) for forms. */
export function ResourceSelect({ id, value, onChange, kinds, allowEmpty = true, emptyLabel = "— None —" }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  kinds?: string[];
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  const query = useQuery({
    queryKey: qk.resourceList("select", { kind: kinds ?? [] }),
    queryFn: () => resourcesApi.list({ kind: kinds, page_size: 500 }),
  });
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={query.isLoading}>
      {allowEmpty && <option value="">{query.isLoading ? "Loading…" : emptyLabel}</option>}
      {(query.data?.items ?? []).map((r) => (
        <option key={r.id} value={r.id}>{r.name} ({KIND_LABELS[r.kind] ?? r.kind})</option>
      ))}
    </NativeSelect>
  );
}

export function useGroups() {
  return useQuery({ queryKey: qk.groups, queryFn: groupsApi.list, staleTime: 60000 });
}

export function useTeams() {
  return useQuery({ queryKey: qk.teams, queryFn: teamsApi.list, staleTime: 60000 });
}

export function useMembers() {
  return useQuery({ queryKey: qk.userList({ page_size: 500 }), queryFn: () => usersApi.list({ page_size: 500 }), staleTime: 60000 });
}

export function usePolicies() {
  return useQuery({ queryKey: qk.policies, queryFn: notificationsApi.policies, staleTime: 60000 });
}

export function useChannels() {
  return useQuery({ queryKey: qk.channels, queryFn: notificationsApi.channels, staleTime: 30000 });
}

export function GroupSelect({ id, value, onChange, emptyLabel = "— No group —", exclude }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  emptyLabel?: string;
  exclude?: string;
}) {
  const q = useGroups();
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {(q.data ?? []).filter((g) => g.id !== exclude).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </NativeSelect>
  );
}

export function GroupPicker({ id, value, onChange }: { id?: string; value: string[]; onChange: (v: string[]) => void }) {
  const q = useGroups();
  return (
    <MultiSelect id={id} value={value} onChange={onChange} loading={q.isLoading} placeholder="Select groups…"
      options={(q.data ?? []).map((g) => ({ value: g.id, label: g.name, hint: `${g.resource_count}` }))} emptyText="No groups defined" />
  );
}

export function TeamSelect({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  const q = useTeams();
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— No team —</option>
      {(q.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </NativeSelect>
  );
}

export function TeamPicker({ id, value, onChange }: { id?: string; value: string[]; onChange: (v: string[]) => void }) {
  const q = useTeams();
  return (
    <MultiSelect id={id} value={value} onChange={onChange} loading={q.isLoading} placeholder="Select teams…"
      options={(q.data ?? []).map((t) => ({ value: t.id, label: t.name }))} emptyText="No teams defined" />
  );
}

export function MemberSelect({ id, value, onChange, emptyLabel = "— Unassigned —" }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  emptyLabel?: string;
}) {
  const q = useMembers();
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={q.isLoading}>
      <option value="">{emptyLabel}</option>
      {(q.data?.items ?? []).filter((m) => m.is_active).map((m) => (
        <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>
      ))}
    </NativeSelect>
  );
}

export function MemberPicker({ id, value, onChange }: { id?: string; value: string[]; onChange: (v: string[]) => void }) {
  const q = useMembers();
  return (
    <MultiSelect id={id} value={value} onChange={onChange} loading={q.isLoading} placeholder="Select members…"
      options={(q.data?.items ?? []).map((m) => ({ value: m.user_id, label: m.full_name || m.email, hint: m.role }))} />
  );
}

export function PolicySelect({ id, value, onChange }: { id?: string; value: string; onChange: (v: string) => void }) {
  const q = usePolicies();
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Default routing —</option>
      {(q.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? " (default)" : ""}</option>)}
    </NativeSelect>
  );
}

export function ChannelPicker({ id, value, onChange }: { id?: string; value: string[]; onChange: (v: string[]) => void }) {
  const q = useChannels();
  return (
    <MultiSelect id={id} value={value} onChange={onChange} loading={q.isLoading} placeholder="Select channels…"
      options={(q.data ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.type }))} emptyText="No channels — create one first" />
  );
}

/** Pick checks across resources (loads resources with their checks). */
export function CheckPicker({ id, value, onChange }: { id?: string; value: string[]; onChange: (v: string[]) => void }) {
  const q = useQuery({
    queryKey: qk.resourceList("check-picker", {}),
    queryFn: () => resourcesApi.list({ page_size: 500 }),
  });
  const options: Option[] = [];
  for (const r of q.data?.items ?? []) {
    for (const c of r.checks ?? []) options.push({ value: c.id, label: `${r.name} · ${c.name}`, hint: c.type, status: c.state });
  }
  return <MultiSelect id={id} value={value} onChange={onChange} loading={q.isLoading} options={options} placeholder="Select checks…" />;
}
