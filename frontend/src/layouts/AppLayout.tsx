import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Building2,
  Check,
  ChevronsUpDown,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  UserRound,
  X,
} from "lucide-react";
import * as React from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { incidentsApi, notificationsApi, resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { SeverityBadge, StatusDot } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "@/components/ui/menus";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/features/auth/AuthProvider";
import { useLiveInterval, useRealtime } from "@/features/realtime/RealtimeProvider";
import { useDebounced } from "@/hooks/useApi";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { NAV_SECTIONS } from "@/layouts/nav";
import { cn } from "@/utils/cn";
import { formatRelative, humanize } from "@/utils/format";
import { KIND_LABELS, resourcePath } from "@/utils/status";

const COLLAPSE_KEY = "emonitor.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- sidebar

export function Sidebar({ collapsed, onToggle, mobileOpen, onCloseMobile }: {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { can } = useAuth();
  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onCloseMobile} aria-hidden />}
      <aside
        aria-label="Main navigation"
        data-collapsed={collapsed}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-150",
          "lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "w-[52px]" : "w-60",
        )}
      >
        <div className={cn("flex h-12 items-center gap-2 border-b border-sidebar-border px-3", collapsed && "justify-center px-0")}>
          <svg viewBox="0 0 32 32" className="size-6 shrink-0" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#0f172a" />
            <path d="M5 17h5l3-7 5 13 3-6h6" fill="none" stroke="#22c55e" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {!collapsed && <span className="text-sm font-semibold tracking-tight">eMonitor</span>}
          <button type="button" onClick={onCloseMobile} aria-label="Close navigation"
            className="ml-auto rounded p-1 hover:bg-sidebar-accent lg:hidden">
            <X className="size-4" />
          </button>
        </div>
        <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
          {NAV_SECTIONS.map((section) => {
            const items = section.items.filter((i) => !i.anyOf || i.anyOf.some((p) => can(p)));
            if (!items.length) return null;
            return (
              <div key={section.title} className="mb-3">
                {!collapsed && (
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</p>
                )}
                <ul className="flex flex-col gap-0.5">
                  {items.map((item) => {
                    const link = (
                      <NavLink
                        to={item.to}
                        end={item.end}
                        onClick={onCloseMobile}
                        aria-label={collapsed ? item.label : undefined}
                        className={({ isActive }) =>
                          cn(
                            "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring",
                            isActive && "bg-sidebar-accent font-medium text-foreground",
                            item.indent && !collapsed && "pl-7 text-xs",
                            collapsed && "justify-center px-0",
                          )
                        }
                      >
                        <item.icon className={cn("shrink-0", item.indent ? "size-3.5" : "size-4")} aria-hidden />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </NavLink>
                    );
                    return (
                      <li key={item.to}>
                        {collapsed ? <Tooltip content={item.label} side="right">{link}</Tooltip> : link}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="hidden border-t border-sidebar-border p-2 lg:block">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-sidebar-accent",
              collapsed && "justify-center px-0")}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------- org switcher

function OrgSwitcher() {
  const { me, orgId, switchOrg, membership } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Switch organization"
          className="flex h-8 max-w-[220px] items-center gap-2 rounded-md border bg-card px-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{membership?.organization_name ?? "No organization"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {me.memberships.map((m) => (
          <DropdownMenuItem key={m.organization_id} onSelect={() => { switchOrg(m.organization_id); navigate("/"); }}>
            <span className="min-w-0 flex-1 truncate">{m.organization_name}</span>
            <span className="text-[10px] text-muted-foreground">{humanize(m.role)}</span>
            {m.organization_id === orgId && <Check className="text-primary" aria-label="current" />}
          </DropdownMenuItem>
        ))}
        {me.user.is_superadmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate("/settings?tab=platform")}>Manage organizations…</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- global search

function GlobalSearch() {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const dq = useDebounced(q.trim(), 250);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const enabled = dq.length >= 2;
  const resources = useQuery({
    queryKey: qk.resourceList("search", { q: dq }),
    queryFn: () => resourcesApi.list({ q: dq, page_size: 6 }),
    enabled,
  });
  const incidents = useQuery({
    queryKey: qk.incidentList({ q: dq, page_size: 6, scope: "search" }),
    queryFn: () => incidentsApi.list({ q: dq, page_size: 6 }),
    enabled,
  });

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setQ("");
    navigate(path);
  };

  const rItems = resources.data?.items ?? [];
  const iItems = incidents.data?.items ?? [];

  return (
    <Popover open={open && enabled} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={open && enabled}
            aria-controls="global-search-results"
            aria-label="Search resources and incidents"
            placeholder="Search resources, incidents (INC-123)…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter") {
                if (rItems[0]) go(resourcePath(rItems[0].kind, rItems[0].id));
                else if (iItems[0]) go(`/incidents/${iItems[0].id}`);
              }
            }}
            className="h-8 w-full rounded-md border border-input bg-card pl-8 pr-12 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1 text-[10px] text-muted-foreground sm:block">Ctrl K</kbd>
        </div>
      </PopoverAnchor>
      <PopoverContent id="global-search-results" className="w-[min(92vw,480px)] p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        {(resources.isLoading || incidents.isLoading) && <p className="px-2 py-2 text-xs text-muted-foreground">Searching…</p>}
        {!resources.isLoading && !incidents.isLoading && !rItems.length && !iItems.length && (
          <p className="px-2 py-2 text-xs text-muted-foreground">No resources or incidents match “{dq}”.</p>
        )}
        {rItems.length > 0 && (
          <div className="py-1">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Resources</p>
            {rItems.map((r) => (
              <button key={r.id} type="button" onClick={() => go(resourcePath(r.kind, r.id))}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <StatusDot status={r.status} />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="text-xs text-muted-foreground">{KIND_LABELS[r.kind] ?? r.kind}</span>
              </button>
            ))}
          </div>
        )}
        {iItems.length > 0 && (
          <div className="border-t py-1">
            <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Incidents</p>
            {iItems.map((i) => (
              <button key={i.id} type="button" onClick={() => go(`/incidents/${i.id}`)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <span className="font-mono text-xs text-muted-foreground">INC-{i.number}</span>
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <SeverityBadge severity={i.severity} />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- notification inbox

function NotificationBell() {
  const navigate = useNavigate();
  const toast = useToast();
  const interval = useLiveInterval(120000, 30000);
  const [open, setOpen] = React.useState(false);
  const inbox = useQuery({ queryKey: qk.inbox, queryFn: () => notificationsApi.inbox(false, 30), refetchInterval: interval });
  const unread = inbox.data?.unread ?? 0;
  const markRead = async (ids: string[] | null) => {
    try {
      await notificationsApi.markRead(ids);
      await inbox.refetch();
    } catch {
      toast.error("Could not mark notifications as read");
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"} className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          <Button variant="ghost" size="sm" disabled={!unread} onClick={() => void markRead(null)}>Mark all read</Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {inbox.isLoading && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
          {inbox.isError && <p className="p-3 text-xs text-destructive">Could not load notifications.</p>}
          {inbox.data && !inbox.data.items.length && <p className="p-6 text-center text-xs text-muted-foreground">You're all caught up.</p>}
          {inbox.data?.items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                if (!n.read_at) void markRead([n.id]);
                setOpen(false);
                if (n.incident_id) navigate(`/incidents/${n.incident_id}`);
              }}
              className={cn("flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left last:border-0 hover:bg-accent", !n.read_at && "bg-primary/5")}
            >
              <span className="flex items-center gap-2 text-sm">
                {!n.read_at && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="unread" />}
                <span className="min-w-0 flex-1 truncate font-medium">{n.title}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(n.created_at)}</span>
              </span>
              {n.body && <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------- theme toggle & user menu

const THEME_ICON: Record<ThemePreference, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon = THEME_ICON[preference];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${preference}`}><Icon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(["light", "dark", "system"] as ThemePreference[]).map((t) => {
          const I = THEME_ICON[t];
          return (
            <DropdownMenuItem key={t} onSelect={() => setPreference(t)}>
              <I /> {humanize(t)} {preference === t && <Check className="ml-auto text-primary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { user, logout, membership } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const initials = (user.full_name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="User menu"
          className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary hover:bg-primary/25 focus-visible:outline-2 focus-visible:outline-ring">
          {initials || <UserRound className="size-4" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{user.full_name || user.email}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          {membership && <p className="mt-0.5 text-[11px] text-muted-foreground">{humanize(membership.role)}</p>}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/profile")}><UserRound /> Profile & security</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { void logout().then(() => navigate("/login")); }}><LogOut /> Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveIndicator() {
  const { status } = useRealtime();
  const label = status === "connected" ? "Live updates connected" : status === "connecting" ? "Connecting to live updates…"
    : "Live updates unavailable — polling every 30s";
  return (
    <Tooltip content={label}>
      <span tabIndex={0} aria-label={label} className="hidden items-center gap-1.5 rounded px-1.5 text-[11px] text-muted-foreground md:inline-flex">
        <span className={cn("size-1.5 rounded-full", status === "connected" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-slate-400")} />
        {status === "connected" ? "Live" : "Polling"}
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------- layout

export function AppLayout() {
  const [collapsed, setCollapsed] = React.useState<boolean>(readCollapsed);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const location = useLocation();

  React.useEffect(() => setMobileOpen(false), [location.pathname]);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:rounded focus:bg-primary focus:px-3 focus:py-1.5 focus:text-primary-foreground">
        Skip to content
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggle} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}>
            <Menu />
          </Button>
          <OrgSwitcher />
          <div className="mx-2 flex flex-1 justify-center">
            <GlobalSearch />
          </div>
          <LiveIndicator />
          <ThemeToggle />
          <NotificationBell />
          <UserMenu />
        </header>
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] p-3 sm:p-4 lg:p-5">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-center">
      <p className="text-4xl font-semibold">404</p>
      <p className="text-sm text-muted-foreground">This page does not exist.</p>
      <Link to="/" className="text-sm text-primary hover:underline">Back to overview</Link>
    </div>
  );
}
