import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddServiceDialog } from "@/pages/services/AddServiceDialog";
import { makeResource } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

describe("AddServiceDialog", () => {
  it("switches type-specific check fields when the check type changes", async () => {
    const { user } = await renderAuthed(<AddServiceDialog open onOpenChange={vi.fn()} />);
    const check = screen.getByRole("region", { name: "Check 1" });
    // TCP (default)
    expect(within(check).getByLabelText(/^Host/)).toBeInTheDocument();
    expect(within(check).getByLabelText(/^Port/)).toHaveValue(80);
    expect(within(check).queryByLabelText("Record type")).not.toBeInTheDocument();

    await user.selectOptions(within(check).getByLabelText("Check type"), "dns");
    expect(within(check).getByLabelText("Record type")).toBeInTheDocument();
    expect(within(check).queryByLabelText(/^Port/)).not.toBeInTheDocument();
    expect(within(check).getByLabelText(/Check name/)).toHaveValue("DNS");

    await user.selectOptions(within(check).getByLabelText("Check type"), "postgres");
    expect(within(check).getByLabelText(/^Port/)).toHaveValue(5432);
    expect(within(check).getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(within(check).getByText("Credentials (write-only)")).toBeInTheDocument();
  });

  it("submits multiple checks with their type-specific config and write-only secrets", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(http.post(u("/services"), async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(makeResource({ id: "s1", kind: "database", name: "Orders DB" }), { status: 201 });
    }));
    const { user } = await renderAuthed(<AddServiceDialog open onOpenChange={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Kind"), "database");
    await user.type(screen.getByLabelText(/^Name/), "Orders DB");

    const first = screen.getByRole("region", { name: "Check 1" });
    await user.selectOptions(within(first).getByLabelText("Check type"), "dns");
    await user.type(within(first).getByLabelText(/^Name\s*\*?$/), "db.example.com");

    await user.click(screen.getByRole("button", { name: /Add another check/ }));
    const second = screen.getByRole("region", { name: "Check 2" });
    await user.selectOptions(within(second).getByLabelText("Check type"), "postgres");
    await user.type(within(second).getByLabelText(/^Host/), "10.1.2.3");
    await user.type(within(second).getByLabelText("Password"), "pg-pass");

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(body).not.toBeNull());
    const b = body as unknown as { kind: string; name: string; checks: Record<string, unknown>[] };
    expect(b.kind).toBe("database");
    expect(b.name).toBe("Orders DB");
    expect(b.checks).toHaveLength(2);
    expect(b.checks[0]).toMatchObject({ name: "DNS", type: "dns", config: { name: "db.example.com", record_type: "A", match: "any" } });
    expect(b.checks[0]).not.toHaveProperty("secrets");
    expect(b.checks[1]).toMatchObject({
      name: "PostgreSQL",
      type: "postgres",
      config: { host: "10.1.2.3", port: 5432, tls: "prefer" },
      secrets: { password: "pg-pass" },
      interval_seconds: 60,
      timeout_seconds: 10,
    });
  });

  it("blocks submission when a check is missing required fields", async () => {
    const post = vi.fn();
    server.use(http.post(u("/services"), () => {
      post();
      return HttpResponse.json({}, { status: 201 });
    }));
    const { user } = await renderAuthed(<AddServiceDialog open onOpenChange={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Name/), "Cache");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Host is required")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});
