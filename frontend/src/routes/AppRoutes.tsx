import * as React from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { LoadingState } from "@/components/ui/states";
import { useAuth } from "@/features/auth/AuthProvider";
import { AppLayout, NotFoundPage } from "@/layouts/AppLayout";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage } from "@/pages/auth/AuthPages";

function lazyNamed<K extends string, T extends Record<K, React.ComponentType>>(loader: () => Promise<T>, name: K) {
  return React.lazy(async () => ({ default: (await loader())[name] }));
}

const OverviewPage = lazyNamed(() => import("@/pages/overview/OverviewPage"), "OverviewPage");
const ServersPage = lazyNamed(() => import("@/pages/servers/ServersPage"), "ServersPage");
const ServerDetailPage = lazyNamed(() => import("@/pages/servers/ServerDetailPage"), "ServerDetailPage");
const ServerComparePage = lazyNamed(() => import("@/pages/servers/ServerComparePage"), "ServerComparePage");
const InventoryPage = lazyNamed(() => import("@/pages/inventory/InventoryPage"), "InventoryPage");
const WebsitesPage = lazyNamed(() => import("@/pages/websites/WebsitesPage"), "WebsitesPage");
const WebsiteDetailPage = lazyNamed(() => import("@/pages/websites/WebsiteDetailPage"), "WebsiteDetailPage");
const DevicesPage = lazyNamed(() => import("@/pages/devices/DevicesPage"), "DevicesPage");
const DeviceDetailPage = lazyNamed(() => import("@/pages/devices/DeviceDetailPage"), "DeviceDetailPage");
const ServicesPage = lazyNamed(() => import("@/pages/services/ServicesPage"), "ServicesPage");
const ServiceDetailPage = lazyNamed(() => import("@/pages/services/ServiceDetailPage"), "ServiceDetailPage");
const ResourceRedirect = lazyNamed(() => import("@/pages/services/ResourceRedirect"), "ResourceRedirect");
const LogsPage = lazyNamed(() => import("@/pages/logs/LogsPage"), "LogsPage");
const IncidentsPage = lazyNamed(() => import("@/pages/incidents/IncidentsPage"), "IncidentsPage");
const IncidentDetailPage = lazyNamed(() => import("@/pages/incidents/IncidentDetailPage"), "IncidentDetailPage");
const AlertRulesPage = lazyNamed(() => import("@/pages/alerts/AlertRulesPage"), "AlertRulesPage");
const AlertRuleDetailPage = lazyNamed(() => import("@/pages/alerts/AlertRuleDetailPage"), "AlertRuleDetailPage");
const NotificationsPage = lazyNamed(() => import("@/pages/notifications/NotificationsPage"), "NotificationsPage");
const MaintenancePage = lazyNamed(() => import("@/pages/maintenance/MaintenancePage"), "MaintenancePage");
const ReportsPage = lazyNamed(() => import("@/pages/reports/ReportsPage"), "ReportsPage");
const IntegrationsPage = lazyNamed(() => import("@/pages/integrations/IntegrationsPage"), "IntegrationsPage");
const AgentInstallPage = lazyNamed(() => import("@/pages/integrations/AgentInstallPage"), "AgentInstallPage");
const UsersPage = lazyNamed(() => import("@/pages/users/UsersPage"), "UsersPage");
const AuditPage = lazyNamed(() => import("@/pages/audit/AuditPage"), "AuditPage");
const SettingsPage = lazyNamed(() => import("@/pages/settings/SettingsPage"), "SettingsPage");
const ProfilePage = lazyNamed(() => import("@/pages/profile/ProfilePage"), "ProfilePage");

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status, me } = useAuth();
  const location = useLocation();
  if (status === "loading") return <LoadingState label="Restoring session…" className="h-full" />;
  if (status !== "authenticated") return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (me && !me.memberships.length && !me.user.is_superadmin) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Your account is not a member of any organization yet. Ask an administrator to add you.
      </div>
    );
  }
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <LoadingState label="Loading…" className="h-full" />;
  if (status === "authenticated") return <Navigate to="/" replace />;
  return <>{children}</>;
}

const page = (el: React.ReactNode) => <React.Suspense fallback={<LoadingState />}>{el}</React.Suspense>;

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route index element={page(<OverviewPage />)} />
        <Route path="servers" element={page(<ServersPage />)} />
        <Route path="servers/compare" element={page(<ServerComparePage />)} />
        <Route path="servers/:id" element={page(<ServerDetailPage />)} />
        <Route path="inventory" element={page(<InventoryPage />)} />
        <Route path="websites" element={page(<WebsitesPage />)} />
        <Route path="websites/:id" element={page(<WebsiteDetailPage />)} />
        <Route path="network-devices" element={page(<DevicesPage />)} />
        <Route path="network-devices/:id" element={page(<DeviceDetailPage />)} />
        <Route path="services" element={page(<ServicesPage />)} />
        <Route path="services/:id" element={page(<ServiceDetailPage />)} />
        <Route path="resources/:id" element={page(<ResourceRedirect />)} />
        <Route path="logs" element={page(<LogsPage />)} />
        <Route path="incidents" element={page(<IncidentsPage />)} />
        <Route path="incidents/:id" element={page(<IncidentDetailPage />)} />
        <Route path="alerts" element={page(<AlertRulesPage />)} />
        <Route path="alerts/:id" element={page(<AlertRuleDetailPage />)} />
        <Route path="notifications" element={page(<NotificationsPage />)} />
        <Route path="maintenance" element={page(<MaintenancePage />)} />
        <Route path="reports" element={page(<ReportsPage />)} />
        <Route path="integrations" element={page(<IntegrationsPage />)} />
        <Route path="agents/install" element={page(<AgentInstallPage />)} />
        <Route path="users" element={page(<UsersPage />)} />
        <Route path="audit" element={page(<AuditPage />)} />
        <Route path="settings" element={page(<SettingsPage />)} />
        <Route path="profile" element={page(<ProfilePage />)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
