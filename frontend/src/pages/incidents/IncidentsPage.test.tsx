import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IncidentsPage } from "@/pages/incidents/IncidentsPage";
import { makeIncident, makeMe } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

const items = [
  makeIncident(),
  makeIncident({ id: "i0000000-0000-4000-8000-000000000002", number: 43, title: "High CPU on web-01", severity: "warning" }),
];

describe("IncidentsPage", () => {
  it("bulk acknowledges the selected incidents", async () => {
    let bulkBody: unknown = null;
    server.use(
      http.get(u("/incidents"), () => HttpResponse.json({ items, total: 2, page: 1, page_size: 50 })),
      http.post(u("/incidents/bulk"), async ({ request }) => {
        bulkBody = await request.json();
        return HttpResponse.json({ updated: 2, not_found: 0 });
      }),
    );
    const { user } = await renderAuthed(<IncidentsPage />, { route: "/incidents", path: "/incidents" });
    expect(await screen.findByText("High CPU on web-01")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all incidents on this page" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(bulkBody).toEqual({ ids: [items[0].id, items[1].id], action: "acknowledge", note: "" }));
    expect(await screen.findByText("Acknowledged 2 incidents")).toBeInTheDocument();
  });

  it("passes URL filters to the API and hides bulk selection without incidents:bulk", async () => {
    let url: URL | null = null;
    server.use(
      http.get(u("/auth/me"), () => HttpResponse.json(makeMe(["view", "incidents:operate"]))),
      http.get(u("/incidents"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ items, total: 2, page: 1, page_size: 50 });
      }),
    );
    await renderAuthed(<IncidentsPage />, { route: "/incidents?severity=critical&open=true&q=INC-42", path: "/incidents" });
    expect(await screen.findByText("High CPU on web-01")).toBeInTheDocument();
    await waitFor(() => expect(url).not.toBeNull());
    const params = (url as URL | null)?.searchParams;
    expect(params?.getAll("severity")).toEqual(["critical"]);
    expect(params?.get("open")).toBe("true");
    expect(params?.get("q")).toBe("INC-42");
    expect(screen.queryByRole("checkbox", { name: /Select all/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New incident" })).toBeInTheDocument();
  });
});
