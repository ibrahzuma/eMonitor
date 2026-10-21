import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NotificationsPage } from "@/pages/notifications/NotificationsPage";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import type { Channel } from "@/types/api";

const telegram: Channel = {
  id: "ch-1", name: "Ops Telegram", type: "telegram", config: { chat_id: "-1001", parse_mode: null },
  secrets_configured: ["bot_token"], enabled: true, rate_limit_per_hour: 60, last_test_at: null, last_test_ok: null,
  created_at: "2026-10-20T00:00:00Z",
};

describe("notification channels", () => {
  it("creates a telegram channel with config and write-only secrets", async () => {
    let body: unknown = null;
    server.use(http.post(u("/notifications/channels"), async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...telegram, id: "ch-new" }, { status: 201 });
    }));
    const { user } = await renderAuthed(<NotificationsPage />, { route: "/notifications" });
    await user.click(await screen.findByRole("button", { name: /New channel/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Ops Telegram");
    await user.selectOptions(within(dialog).getByLabelText("Type"), "telegram");
    await user.click(within(dialog).getByRole("button", { name: "Create channel" }));
    expect(await within(dialog).findByText("Bot token is required")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Chat ID/), "-1001");
    await user.type(within(dialog).getByLabelText(/^Bot token/), "123456:ABCDEFGHIJ");
    await user.click(within(dialog).getByRole("button", { name: "Create channel" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      name: "Ops Telegram", type: "telegram", config: { chat_id: "-1001" }, secrets: { bot_token: "123456:ABCDEFGHIJ" },
      enabled: true, rate_limit_per_hour: 60,
    });
  });

  it("never pre-fills secrets on edit and omits them when left blank", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.get(u("/notifications/channels"), () => HttpResponse.json([telegram])),
      http.put(u("/notifications/channels/ch-1"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(telegram);
      }),
    );
    const { user } = await renderAuthed(<NotificationsPage />, { route: "/notifications" });
    expect(await screen.findByText("bot_token")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Ops Telegram" }));
    const dialog = await screen.findByRole("dialog");
    const token = within(dialog).getByLabelText(/^Bot token/);
    expect(token).toHaveValue("");
    expect(within(dialog).getByText(/Configured — leave blank/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Type")).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/^Chat ID/));
    await user.type(within(dialog).getByLabelText(/^Chat ID/), "-2002");
    await user.click(within(dialog).getByRole("button", { name: "Save channel" }));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).not.toHaveProperty("secrets");
    expect(body).toMatchObject({ type: "telegram", config: { chat_id: "-2002" } });
  });
});
