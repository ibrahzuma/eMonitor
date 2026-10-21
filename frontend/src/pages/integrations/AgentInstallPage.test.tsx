import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentInstallPage } from "@/pages/integrations/AgentInstallPage";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

const INFO = {
  server_url: "https://monitor.example.com",
  install_script_url: "https://monitor.example.com/api/v1/agents/install.sh",
  package_url: "https://monitor.example.com/api/v1/agents/package.tar.gz",
  agent_version: "1.0.0",
  package_sha256: "ab".repeat(32),
  install_command_template: "curl -fsSL https://monitor.example.com/api/v1/agents/install.sh | sudo bash -s -- --token <ENROLLMENT_TOKEN>",
  upgrade_command: "curl -fsSL https://monitor.example.com/api/v1/agents/install.sh | sudo bash -s -- --upgrade",
};

describe("agent installation guide", () => {
  it("shows the template command, then the real command after creating a token", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get(u("/agents/info"), () => HttpResponse.json(INFO)),
      http.post(u("/agents/enrollment-tokens"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "t1", description: "web", server_id: null, max_uses: 5, use_count: 0, created_at: "2026-10-21T00:00:00Z",
          expires_at: "2026-10-22T00:00:00Z", revoked_at: null, token: "emt_secret123",
          install_command: "curl -fsSL https://monitor.example.com/api/v1/agents/install.sh | sudo bash -s -- --token emt_secret123",
        }, { status: 201 });
      }),
    );
    const { user } = await renderAuthed(<AgentInstallPage />, { route: "/agents/install" });
    expect((await screen.findAllByText(/--token <ENROLLMENT_TOKEN>/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/--upgrade/)).toBeInTheDocument();
    expect(screen.getByText("Agent v1.0.0")).toBeInTheDocument();
    const uses = screen.getByLabelText(/How many servers/);
    await user.clear(uses);
    await user.type(uses, "5");
    await user.click(screen.getByRole("button", { name: /Create enrollment token/ }));
    await waitFor(() => expect(screen.getAllByText(/--token emt_secret123/).length).toBe(1));
    expect(screen.getByText(/Copy the token now/)).toBeInTheDocument();
    expect(body).toMatchObject({ max_uses: 5, expires_in_hours: 24 });
  });
});
