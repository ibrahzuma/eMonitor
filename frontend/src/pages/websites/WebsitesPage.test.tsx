import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddWebsiteDialog } from "@/pages/websites/AddWebsiteDialog";
import { makeResource } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

function renderDialog() {
  return renderAuthed(<AddWebsiteDialog open onOpenChange={vi.fn()} />);
}

describe("AddWebsiteDialog", () => {
  it("validates name, URL and status codes on the client without sending a request", async () => {
    const post = vi.fn();
    server.use(http.post(u("/websites"), () => {
      post();
      return HttpResponse.json(makeResource({ kind: "website" }), { status: 201 });
    }));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText(/^URL/), "ftp://example.com");
    const status = screen.getByLabelText(/Expected status codes/);
    await user.clear(status);
    await user.type(status, "200, 6xx");
    await user.click(screen.getByRole("button", { name: "Add website" }));
    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("URL must use http or https")).toBeInTheDocument();
    expect(screen.getByText(/Invalid status "6xx"/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^URL/)).toHaveAttribute("aria-invalid", "true");
    expect(post).not.toHaveBeenCalled();
  });

  it("submits the full payload, including secrets only when filled", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post(u("/websites"), async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(makeResource({ id: "w1", kind: "website", name: "Shop" }), { status: 201 });
    }));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText(/^Name/), "Shop");
    await user.type(screen.getByLabelText(/^URL/), "https://shop.example.com/health");
    const status = screen.getByLabelText(/Expected status codes/);
    await user.clear(status);
    await user.type(status, "200, 301-302");
    await user.type(screen.getByLabelText(/^Keyword/), "OK");
    await user.type(screen.getByLabelText(/Bearer token/), "s3cret");
    await user.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      name: "Shop",
      description: "",
      environment: "production",
      location: "",
      business_owner: "",
      group_id: null,
      team_id: null,
      tags: [],
      notification_policy_id: null,
      url: "https://shop.example.com/health",
      kind: "website",
      method: "GET",
      expected_status: ["200", "301-302"],
      interval_seconds: 60,
      timeout_seconds: 10,
      keyword: "OK",
      keyword_absent: false,
      headers: {},
      body: null,
      expected_headers: {},
      json_assertions: [],
      verify_tls: true,
      ssl_check: true,
      ssl_alert_days: null,
      degraded_threshold_ms: null,
      follow_redirects: true,
      failure_threshold: 2,
      severity: "critical",
      monitor_dns: true,
      dns_record_type: "A",
      monitor_domain: true,
      domain: null,
      domain_alert_days: null,
      secrets: { bearer_token: "s3cret" },
    });
  });

  it("shows the detected domain and sends DNS/domain options", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post(u("/websites"), async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(makeResource({ id: "w3", kind: "website" }), { status: 201 });
    }));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText(/^Name/), "Qalaam");
    await user.type(screen.getByLabelText(/^URL/), "https://www.qalaam.co.tz/");
    expect(screen.getByText(/Detected: qalaam\.co\.tz/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Monitor DNS resolution" }));
    await user.type(screen.getByLabelText(/Domain alert days/), "30, 7");
    await user.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ monitor_dns: false, monitor_domain: true, domain: null, domain_alert_days: [30, 7] });
  });

  it("omits secrets entirely when no credential is entered", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post(u("/websites"), async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(makeResource({ id: "w2", kind: "website" }), { status: 201 });
    }));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText(/^Name/), "Blog");
    await user.type(screen.getByLabelText(/^URL/), "https://blog.example.com");
    await user.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).not.toHaveProperty("secrets");
  });

  it("maps a 422 server validation error onto the URL field", async () => {
    server.use(http.post(u("/websites"), () => HttpResponse.json({
      error: {
        code: "validation_error",
        message: "invalid check configuration",
        details: [{ loc: ["body", "config", "url"], msg: "Value error, target not allowed by monitoring scope" }],
        request_id: "r1",
      },
    }, { status: 422 })));
    const { user } = await renderDialog();
    await user.type(screen.getByLabelText(/^Name/), "Intranet");
    await user.type(screen.getByLabelText(/^URL/), "https://10.0.0.5/");
    await user.click(screen.getByRole("button", { name: "Add website" }));
    const msgs = await screen.findAllByText(/target not allowed by monitoring scope/);
    expect(msgs.length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText(/^URL/)).toHaveAttribute("aria-invalid", "true"));
  });
});
