import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogsPage } from "@/pages/logs/LogsPage";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import type { LogRow } from "@/types/api";

const row = (i: number, overrides: Partial<LogRow> = {}): LogRow => ({
  ts: `2026-10-21T06:5${i}:00Z`, id: `00000000-0000-4000-8000-00000000000${i}`, resource_id: "00000000-0000-0000-0000-000000000000",
  host: "web-01", application: "api", service: "", source: "app", environment: "production", severity: "error",
  message: `request failed ${i}`, trace_id: `trace-${i}`, attributes: { user_id: "42" }, ...overrides,
});

describe("LogsPage", () => {
  it("searches, paginates with a cursor and filters by facet / trace id", async () => {
    const searches: URLSearchParams[] = [];
    server.use(
      http.get(u("/logs/search"), ({ request }) => {
        const p = new URL(request.url).searchParams;
        searches.push(p);
        if (p.get("cursor") === "c1") return HttpResponse.json({ items: [row(2)], next_cursor: null, start: "", end: "" });
        return HttpResponse.json({ items: [row(1)], next_cursor: "c1", start: "", end: "" });
      }),
      http.get(u("/logs/histogram"), () => HttpResponse.json({ bucket_seconds: 60, points: [{ bucket: "2026-10-21T06:50:00Z", severity: "error", count: 2 }] })),
      http.get(u("/logs/facets"), ({ request }) => {
        const f = new URL(request.url).searchParams.get("field");
        return HttpResponse.json(f === "host" ? [{ value: "web-01", count: 2 }] : []);
      }),
      http.get(u("/saved-searches"), () => HttpResponse.json([])),
    );
    const { user } = await renderAuthed(<LogsPage />, { route: "/logs?range=24h", path: "/logs" });
    expect(await screen.findByText("request failed 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("request failed 2")).toBeInTheDocument();
    expect(screen.getByText(/End of results/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /web-01\s*2/ }));
    await waitFor(() => expect(searches.some((p) => p.getAll("host").includes("web-01"))).toBe(true));

    await user.click(await screen.findByText("request failed 1"));
    await user.click(screen.getByRole("button", { name: "trace-1" }));
    await waitFor(() => expect(searches.some((p) => p.get("trace_id") === "trace-1")).toBe(true));
    expect(searches.every((p) => p.get("range") === "24h")).toBe(true);
    // live tail is unavailable without a websocket connection
    expect(screen.getByRole("button", { name: /Live tail/ })).toBeDisabled();
  });
});
