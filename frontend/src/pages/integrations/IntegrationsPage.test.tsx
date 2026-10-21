import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationsPage } from "@/pages/integrations/IntegrationsPage";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

describe("integrations: API keys", () => {
  it("creates an API key and shows the full key once", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get(u("/api-keys"), () => HttpResponse.json([])),
      http.post(u("/api-keys"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "k1", name: "Log shipper", prefix: "emk_ab12", role: "it_admin", scopes: ["logs:write"], created_at: "2026-10-21T00:00:00Z",
          last_used_at: null, expires_at: null, revoked_at: null, key: "emk_ab12.supersecretvalue",
        }, { status: 201 });
      }),
    );
    const { user } = await renderAuthed(<IntegrationsPage />, { route: "/integrations" });
    expect(await screen.findByText("No API keys")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New API key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Log shipper");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "it_admin");
    await user.click(within(dialog).getByRole("checkbox", { name: "logs:write" }));
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(within(dialog).getByTestId("one-time-secret")).toHaveTextContent("emk_ab12.supersecretvalue"));
    expect(within(dialog).getByText(/shown only once/)).toBeInTheDocument();
    expect(body).toEqual({ name: "Log shipper", role: "it_admin", scopes: ["logs:write"], expires_at: null });
  });
});
