import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeMe } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import { AppLayout } from "@/layouts/AppLayout";

describe("app layout", () => {
  it("collapses and expands the sidebar and remembers the choice", async () => {
    const { user } = await renderAuthed(<AppLayout />);
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    expect(within(nav).getByText("Overview")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByText("Overview")).not.toBeInTheDocument();
    // links stay accessible by name when collapsed
    expect(within(nav).getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(window.localStorage.getItem("emonitor.sidebar.collapsed")).toBe("1");
    await user.click(expand);
    expect(within(nav).getByText("Overview")).toBeInTheDocument();
  });

  it("opens the mobile navigation drawer", async () => {
    const { user } = await renderAuthed(<AppLayout />);
    const open = screen.getByRole("button", { name: "Open navigation" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    await user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Main navigation" }).className).toContain("translate-x-0");
    await user.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(open).toHaveAttribute("aria-expanded", "false");
  });

  it("hides navigation entries the user lacks permission for", async () => {
    server.use(http.get(u("/auth/me"), () => HttpResponse.json(makeMe(["view"]))));
    await renderAuthed(<AppLayout />);
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    expect(within(nav).getByText("Incidents")).toBeInTheDocument();
    expect(within(nav).queryByText("Audit Logs")).not.toBeInTheDocument();
    expect(within(nav).queryByText("System Settings")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Logs")).not.toBeInTheDocument();
  });

  it("shows the unread notification count and lists inbox items", async () => {
    server.use(http.get(u("/notifications/inbox"), () => HttpResponse.json({
      unread: 2,
      items: [
        { id: "n1", incident_id: null, title: "INC-7 triggered", body: "Disk full", severity: "critical", read_at: null, created_at: "2026-10-21T06:00:00Z" },
        { id: "n2", incident_id: null, title: "INC-6 resolved", body: "", severity: "info", read_at: null, created_at: "2026-10-21T05:00:00Z" },
      ],
    })));
    const { user } = await renderAuthed(<AppLayout />);
    const bell = await screen.findByRole("button", { name: "Notifications (2 unread)" });
    await user.click(bell);
    expect(await screen.findByText("INC-7 triggered")).toBeInTheDocument();
    expect(screen.getByText("Disk full")).toBeInTheDocument();
  });

  it("switches organization and sends the new X-Organization-ID", async () => {
    const seen: string[] = [];
    server.use(http.get(u("/notifications/inbox"), ({ request }) => {
      seen.push(request.headers.get("x-organization-id") ?? "");
      return HttpResponse.json({ items: [], unread: 0 });
    }));
    const { user } = await renderAuthed(<AppLayout />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toBe(makeMe().memberships[0].organization_id);
    await user.click(screen.getByRole("button", { name: "Switch organization" }));
    await user.click(await screen.findByRole("menuitem", { name: /Demo Organization/ }));
    const demo = makeMe().memberships[1].organization_id;
    await waitFor(() => expect(seen).toContain(demo));
    expect(window.localStorage.getItem("emonitor.org")).toBe(demo);
  });
});
