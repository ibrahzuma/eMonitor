import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsersPage } from "@/pages/users/UsersPage";
import { USER_ID } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import type { Member } from "@/types/api";

const me: Member = {
  user_id: USER_ID, email: "admin@example.com", full_name: "Administrator", role: "org_admin", is_active: true,
  totp_enabled: false, last_login_at: null, created_at: "2026-10-01T00:00:00Z",
};

describe("UsersPage", () => {
  it("adds a user with the entered payload", async () => {
    let body: unknown = null;
    server.use(
      http.get(u("/users"), () => HttpResponse.json({ items: [me], total: 1, page: 1, page_size: 50 })),
      http.post(u("/users"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...me, user_id: "u2", email: "ops@example.com", full_name: "Ops", role: "operator" }, { status: 201 });
      }),
    );
    const { user } = await renderAuthed(<UsersPage />, { route: "/users" });
    expect(await screen.findByText("Administrator")).toBeInTheDocument();
    // own row offers no deactivate/remove actions
    expect(screen.queryByRole("button", { name: /Remove admin@example.com/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add user/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Email/), "ops@example.com");
    await user.type(within(dialog).getByLabelText(/Full name/), "Ops");
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), "operator");
    await user.type(within(dialog).getByLabelText(/Initial password/), "VeryStrongPass123!");
    await user.click(within(dialog).getByRole("button", { name: "Add user" }));
    await waitFor(() => expect(body).toEqual({ email: "ops@example.com", full_name: "Ops", role: "operator", password: "VeryStrongPass123!" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a conflict error inside the dialog", async () => {
    server.use(
      http.get(u("/users"), () => HttpResponse.json({ items: [me], total: 1, page: 1, page_size: 50 })),
      http.post(u("/users"), () => HttpResponse.json({ error: { code: "conflict", message: "user is already a member of this organization", details: null, request_id: null } }, { status: 409 })),
    );
    const { user } = await renderAuthed(<UsersPage />, { route: "/users" });
    await user.click(await screen.findByRole("button", { name: /Add user/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Email/), "admin@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add user" }));
    expect(await within(dialog).findByText(/already a member/)).toBeInTheDocument();
  });
});
