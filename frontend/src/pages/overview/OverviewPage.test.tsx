import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverviewPage } from "@/pages/overview/OverviewPage";
import { makeSummary } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

function mockDashboard(trends: "ok" | "fail") {
  server.use(
    http.get(u("/dashboard/summary"), () => HttpResponse.json(makeSummary({
      server_overview: [{ id: "s1", name: "db-01", status: "critical", cpu_percent: 97.5, memory_percent: 40, disk_percent_max: 55, load1: 3.2, last_metrics_at: "2026-10-21T06:59:00Z" }],
      recent_failures: [{ check_id: "c1", check: "HTTP", type: "http", resource: "Shop", kind: "website", resource_id: "w1", message: "HTTP 503", since: "2026-10-21T06:00:00Z", last_run_at: null }],
    }))),
    http.get(u("/dashboard/trends"), () => (trends === "ok"
      ? HttpResponse.json({ bucket_seconds: 3600, incidents: [{ ts: "2026-10-21T05:00:00Z", critical: 1, high: 0, warning: 2, info: 0 }], availability: [{ ts: "2026-10-21T05:00:00Z", uptime_percent: 99.9, down: 0, unknown: 0, avg_ms: 120 }] })
      : HttpResponse.json({ error: { code: "internal_error", message: "Internal server error", details: null, request_id: "r" } }, { status: 500 }))),
    http.get(u("/dashboard/traffic"), () => HttpResponse.json({ step: 300, points: [] })),
    http.get(u("/dashboard/activity"), () => HttpResponse.json([
      { ts: "2026-10-21T06:30:00Z", id: "e1", resource_id: "w1", kind: "incident", severity: "critical", title: "Shop is down", message: "", data: {} },
    ])),
    http.get(u("/dashboard/log-errors"), () => HttpResponse.json([])),
  );
}

describe("OverviewPage", () => {
  it("renders summary cards with drill-down links", async () => {
    mockDashboard("ok");
    await renderAuthed(<OverviewPage />);
    const servers = await screen.findByRole("region", { name: "Servers summary" });
    const critical = within(servers).getByRole("link", { name: /Critical/ });
    expect(critical).toHaveAttribute("href", "/servers?status=critical");
    expect(within(critical).getByText("2")).toBeInTheDocument();
    expect(within(servers).getByRole("link", { name: /^Servers/ })).toHaveTextContent("12");
    const web = screen.getByRole("region", { name: "Websites and incidents summary" });
    expect(within(web).getByRole("link", { name: /Uptime 24h/ })).toHaveTextContent("99.50%");
    expect(within(web).getByRole("link", { name: /Critical incidents/ })).toHaveAttribute("href", "/incidents?open=true&severity=critical");
    expect(screen.getByText("db-01")).toBeInTheDocument();
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
    expect(screen.getByText("Shop is down")).toBeInTheDocument();
    expect(screen.queryByText(/Computed in browser/)).not.toBeInTheDocument();
  });

  it("falls back to browser-computed trends when the trends endpoint fails", async () => {
    mockDashboard("fail");
    let incidentQuery = "";
    server.use(http.get(u("/incidents"), ({ request }) => {
      incidentQuery = new URL(request.url).search;
      return HttpResponse.json({ items: [], total: 0, page: 1, page_size: 500 });
    }));
    await renderAuthed(<OverviewPage />);
    expect((await screen.findAllByText("Computed in browser (trends endpoint unavailable)")).length).toBeGreaterThan(0);
    expect(incidentQuery).toContain("start=");
    expect(incidentQuery).toContain("page_size=500");
  });
});
