import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IncidentDetailPage } from "@/pages/incidents/IncidentDetailPage";
import { makeIncident, makeMe } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import type { IncidentDetail } from "@/types/api";

const ID = "i0000000-0000-4000-8000-000000000001";

function detail(overrides: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    ...makeIncident(),
    timeline: [{ id: "e1", kind: "triggered", actor_user_id: null, message: "HTTP check failed", data: {}, created_at: "2026-10-21T06:00:00Z", actor_name: null }],
    deliveries: [],
    related: [],
    ...overrides,
  };
}

const render = () => renderAuthed(<IncidentDetailPage />, { route: `/incidents/${ID}`, path: "/incidents/:id" });

describe("IncidentDetailPage", () => {
  it("acknowledges an incident and updates the status", async () => {
    let called = false;
    let current = detail();
    server.use(
      http.get(u(`/incidents/${ID}`), () => HttpResponse.json(current)),
      http.post(u(`/incidents/${ID}/acknowledge`), () => {
        called = true;
        current = detail({
          status: "acknowledged",
          acknowledged_at: "2026-10-21T06:40:00Z",
          timeline: [...detail().timeline, { id: "e2", kind: "acknowledged", actor_user_id: "u", message: "Acknowledged", data: {}, created_at: "2026-10-21T06:40:00Z", actor_name: "Administrator" }],
        });
        return HttpResponse.json(current);
      }),
    );
    const { user } = await render();
    expect(await screen.findByText("Website down: Example.com")).toBeInTheDocument();
    expect(screen.getByText("INC-42")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(called).toBe(true));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument());
    expect(screen.getAllByText("Acknowledged").length).toBeGreaterThanOrEqual(1);
    expect(within(screen.getByRole("list", { name: "Incident timeline" })).getByText("Administrator")).toBeInTheDocument();
  });

  it("requires a resolution text and sends it when resolving", async () => {
    let body: unknown = null;
    let current = detail({ status: "acknowledged" });
    server.use(
      http.get(u(`/incidents/${ID}`), () => HttpResponse.json(current)),
      http.post(u(`/incidents/${ID}/resolve`), async ({ request }) => {
        body = await request.json();
        current = detail({ status: "resolved", resolution: "Restarted nginx", resolved_at: "2026-10-21T07:00:00Z" });
        return HttpResponse.json(current);
      }),
    );
    const { user } = await render();
    await user.click(await screen.findByRole("button", { name: "Resolve" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Resolve incident" }));
    expect(within(dialog).getByText("Resolution is required")).toBeInTheDocument();
    expect(body).toBeNull();
    await user.type(within(dialog).getByLabelText(/Resolution/), "Restarted nginx");
    await user.click(within(dialog).getByRole("button", { name: "Resolve incident" }));
    await waitFor(() => expect(body).toEqual({ resolution: "Restarted nginx" }));
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.getByText("Restarted nginx")).toBeInTheDocument();
  });

  it("hides incident actions without the incidents:operate permission", async () => {
    server.use(
      http.get(u("/auth/me"), () => HttpResponse.json(makeMe(["view", "logs:read"]))),
      http.get(u(`/incidents/${ID}`), () => HttpResponse.json(detail())),
    );
    await render();
    expect(await screen.findByText("Website down: Example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add comment")).not.toBeInTheDocument();
  });

  it("shows an error state when the incident cannot be loaded", async () => {
    server.use(http.get(u(`/incidents/${ID}`), () =>
      HttpResponse.json({ error: { code: "not_found", message: "Incident not found", details: null, request_id: null } }, { status: 404 })));
    await render();
    expect(await screen.findByText("Incident not found")).toBeInTheDocument();
  });
});
