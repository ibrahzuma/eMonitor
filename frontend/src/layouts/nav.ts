import {
  Activity,
  AppWindow,
  Bell,
  BellRing,
  Boxes,
  CalendarClock,
  Download,
  FileBarChart2,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Plug,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Siren,
  Users,
} from "lucide-react";
import type { Permission } from "@/types/api";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these permissions makes the item visible. */
  anyOf?: Permission[];
  end?: boolean;
  indent?: boolean;
}

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Monitor",
    items: [
      { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
      { to: "/servers", label: "Servers", icon: Server },
      { to: "/agents/install", label: "Install Agent", icon: Download, indent: true },
      { to: "/inventory", label: "Inventory", icon: Boxes, indent: true },
      { to: "/websites", label: "Websites", icon: Globe },
      { to: "/network-devices", label: "Network Devices", icon: Network },
      { to: "/services", label: "Applications & Services", icon: AppWindow },
      { to: "/logs", label: "Logs", icon: ScrollText, anyOf: ["logs:read"] },
    ],
  },
  {
    title: "Respond",
    items: [
      { to: "/incidents", label: "Incidents", icon: Siren },
      { to: "/alerts", label: "Alert Rules", icon: BellRing },
      { to: "/notifications", label: "Notifications", icon: Bell },
      { to: "/maintenance", label: "Maintenance", icon: CalendarClock },
      { to: "/reports", label: "Reports & SLOs", icon: FileBarChart2 },
    ],
  },
  {
    title: "Administer",
    items: [
      { to: "/integrations", label: "Integrations", icon: Plug, anyOf: ["api_keys:manage", "agents:manage"] },
      { to: "/users", label: "Users & Teams", icon: Users },
      { to: "/audit", label: "Audit Logs", icon: ShieldCheck, anyOf: ["audit:read"] },
      { to: "/settings", label: "System Settings", icon: Settings, anyOf: ["org:settings", "platform:admin"] },
    ],
  },
];

export const ACTIVITY_ICON = Activity;
