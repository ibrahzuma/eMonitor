import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AddServerDialog } from "@/pages/servers/AddServerDialog";
import { ServersPage } from "@/pages/servers/ServersPage";
import { makeResource } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

describe("AddServerDialog", () => {
  it("validates required fields client-side without calling the API", async () => {
    let posted = false;
    server.use(http.post(u("/servers"), () => {
      posted = true;
      return HttpResponse.json({}, { status: 201 });
    }));
    const { user } = await renderAuthed(<AddServerDialog open onOpenChange={() => undefined} />);
    await user.click(screen.getByRole("checkbox", { name: /ICMP ping/ }));
    const interval = screen.getByLabelText(/Collection interval/);
    await user.clear(interval);
    await user.type(interval, "5");
    await user.click(screen.getByRole("button", { name: "Add server" }));
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText(/Hostname or IP address is required/)).toBeInTheDocument();
    expect(screen.getByText(/between 10 and 3600/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveAttribute("aria-invalid", "true");
    expect(posted).toBe(false);
  });

  it("submits the exact ServerCreate payload", async () => {
    let body: unknown = null;
    server.use(http.post(u("/servers"), async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(makeResource({ id: "new-1", name: "web-01" }), { status: 201 });
    }));
    let created = "";
    const { user } = await renderAuthed(<AddServerDialog open onOpenChange={() => undefined} onCreated={(r) => { created = r.id; }} />);
    await user.type(screen.getByLabelText(/^Name/), "web-01");
    await user.type(screen.getByLabelText(/^Hostname/), "web-01.internal");
    await user.type(screen.getByLabelText(/Monitored services/), "nginx{Enter}");
    await user.click(screen.getByRole("checkbox", { name: /ICMP ping/ }));
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(created).toBe("new-1"));
    expect(body).toEqual({
      name: "web-01", description: "", environment: "production", location: "", business_owner: "", group_id: null,
      team_id: null, tags: [], notification_policy_id: null, hostname: "web-01.internal", ip_address: "", os_family: "linux",
      os_version: "", monitoring_interval_seconds: 30, agent_timeout_seconds: null, monitored_services: ["nginx"],
      thresholds: {}, ping_check: true,
    });
  });

  it("maps 422 validation details from the API onto fields", async () => {
    server.use(http.post(u("/servers"), () => HttpResponse.json({
      error: { code: "validation_error", message: "Request validation failed", details: [{ loc: ["body", "hostname"], msg: "String should have at most 255 characters" }], request_id: "x" },
    }, { status: 422 })));
    const { user } = await renderAuthed(<AddServerDialog open onOpenChange={() => undefined} />);
    await user.type(screen.getByLabelText(/^Name/), "web-01");
    await user.type(screen.getByLabelText(/^Hostname/), "bad-host");
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(screen.getByLabelText(/^Hostname/)).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getAllByText(/at most 255 characters/).length).toBeGreaterThan(0);
  });
});

describe("ServersPage filtering", () => {
  it("requests /servers with the selected status filter", async () => {
    const urls: string[] = [];
    server.use(http.get(u("/servers"), ({ request }) => {
      const url = new URL(request.url);
      urls.push(url.search);
      const critical = url.searchParams.getAll("status").includes("critical");
      return HttpResponse.json({
        items: critical ? [makeResource({ id: "s2", name: "db-01", status: "critical" })]
          : [makeResource({ id: "s1", name: "web-01" }), makeResource({ id: "s2", name: "db-01", status: "critical" })],
        total: critical ? 1 : 2, page: 1, page_size: 50,
      });
    }));
    const { user } = await renderAuthed(<ServersPage />, { route: "/servers", path: "/servers" });
    expect(await screen.findByText("web-01")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Critical" }));
    await waitFor(() => expect(screen.queryByText("web-01")).not.toBeInTheDocument());
    expect(screen.getByText("db-01")).toBeInTheDocument();
    expect(urls.some((s) => new URLSearchParams(s).getAll("status").join() === "critical")).toBe(true);
    expect(screen.getByRole("button", { name: "Critical" })).toHaveAttribute("aria-pressed", "true");
  });

  it("initialises filters from the URL (dashboard drill-down)", async () => {
    let search = "";
    server.use(http.get(u("/servers"), ({ request }) => {
      search = new URL(request.url).search;
      return HttpResponse.json({ items: [], total: 0, page: 1, page_size: 50 });
    }));
    await renderAuthed(<ServersPage />, { route: "/servers?status=warning&environment=staging", path: "/servers" });
    expect(await screen.findByText("No servers match these filters")).toBeInTheDocument();
    const p = new URLSearchParams(search);
    expect(p.getAll("status")).toEqual(["warning"]);
    expect(p.get("environment")).toBe("staging");
  });
});
