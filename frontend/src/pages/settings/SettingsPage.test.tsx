import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { ORG_ID } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import type { Organization } from "@/types/api";

const org: Organization = {
  id: ORG_ID,
  name: "Acme Corp",
  slug: "acme",
  timezone: "UTC",
  is_active: true,
  settings: { session_idle_minutes: 120, reopen_window_minutes: 60, agent_timeout_seconds: 180, ssl_alert_days: [30, 14], log_retention_days: 14,
    metric_retention_days: 90, logs_per_day_quota: 0, metric_consecutive_samples: 2, unreachable_after_failures: 3 },
  thresholds: { cpu_percent: { warning: 80, critical: 95 } },
  monitoring_scope: { allow_public: true, cidrs: [], hostnames: [] },
  created_at: "2026-10-01T00:00:00Z",
};

describe("SettingsPage", () => {
  it("blocks submit on client-side bounds violations", async () => {
    let patched = false;
    server.use(
      http.get(u("/organizations/current"), () => HttpResponse.json(org)),
      http.patch(u("/organizations/current"), () => { patched = true; return HttpResponse.json(org); }),
    );
    const { user } = await renderAuthed(<SettingsPage />, { route: "/settings" });
    const input = await screen.findByLabelText(/Session idle timeout/);
    await user.clear(input);
    await user.type(input, "2");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/between 5 and 1,?440/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(patched).toBe(false);
  });

  it("shows server 422 validation details next to the field", async () => {
    let body: unknown = null;
    server.use(
      http.get(u("/organizations/current"), () => HttpResponse.json(org)),
      http.patch(u("/organizations/current"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ error: { code: "validation_error", message: "Request validation failed",
          details: [{ loc: ["body", "settings", "session_idle_minutes"], msg: "Server says no" }], request_id: "r" } }, { status: 422 });
      }),
    );
    const { user } = await renderAuthed(<SettingsPage />, { route: "/settings" });
    await screen.findByLabelText(/Session idle timeout/);
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(body).not.toBeNull());
    const settings = (body as { settings: Record<string, unknown> }).settings;
    expect(settings.session_idle_minutes).toBe(120);
    expect(settings.ssl_alert_days).toEqual([30, 14]);
    expect(await screen.findByText("Server says no")).toBeInTheDocument();
    expect(screen.getByLabelText(/Session idle timeout/)).toHaveAttribute("aria-invalid", "true");
  });

  it("saves the monitoring scope", async () => {
    let body: unknown = null;
    server.use(
      http.get(u("/organizations/current"), () => HttpResponse.json(org)),
      http.patch(u("/organizations/current"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(org);
      }),
    );
    const { user } = await renderAuthed(<SettingsPage />, { route: "/settings?tab=scope" });
    expect(await screen.findByText("SSRF protection")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: /Allow public internet targets/ }));
    await user.type(screen.getByLabelText(/Authorized networks/), "10.0.0.0/8{enter}192.168.1.0/24");
    await user.type(screen.getByLabelText(/Authorized hostname patterns/), ".corp.example.com");
    await user.click(screen.getByRole("button", { name: "Save scope" }));
    await waitFor(() => expect(body).toEqual({
      monitoring_scope: { allow_public: false, cidrs: ["10.0.0.0/8", "192.168.1.0/24"], hostnames: [".corp.example.com"] },
    }));
  });
});
