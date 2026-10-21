import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { tokenStore } from "@/api/client";
import { makeMe } from "@/test/fixtures";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderApp } from "@/test/renderApp";

const noSession = http.post(u("/auth/refresh"), () =>
  HttpResponse.json({ error: { code: "unauthorized", message: "No session", details: null, request_id: null } }, { status: 401 }));

const loggedIn = { access_token: "tok-1", token_type: "bearer", expires_in: 900, mfa_required: false, mfa_token: null, user: makeMe().user };

describe("login flow", () => {
  it("redirects anonymous users to the login page", async () => {
    server.use(noSession);
    renderApp("/incidents");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("validates required fields before submitting", async () => {
    server.use(noSession);
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Email is required")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveAttribute("aria-invalid", "true");
  });

  it("signs in with email and password and keeps the token in memory only", async () => {
    let body: unknown = null;
    server.use(noSession, http.post(u("/auth/login"), async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(loggedIn);
    }), http.get(u("/dashboard/*"), () => HttpResponse.json({}, { status: 404 })));
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/), "DevAdmin12345!");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument());
    expect(body).toEqual({ email: "admin@example.com", password: "DevAdmin12345!" });
    expect(tokenStore.get()).toBe("tok-1");
    expect(JSON.stringify(window.localStorage)).not.toContain("tok-1");
  });

  it("shows the API error message for invalid credentials", async () => {
    server.use(noSession, http.post(u("/auth/login"), () =>
      HttpResponse.json({ error: { code: "unauthorized", message: "Invalid email or password", details: null, request_id: "x" } }, { status: 401 })));
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
  });

  it("asks for a TOTP code when MFA is required and completes the login", async () => {
    let mfaBody: unknown = null;
    server.use(
      noSession,
      http.post(u("/auth/login"), () => HttpResponse.json({ access_token: null, token_type: "bearer", expires_in: null, mfa_required: true, mfa_token: "mfa-xyz", user: null })),
      http.post(u("/auth/login/mfa"), async ({ request }) => {
        mfaBody = await request.json();
        return HttpResponse.json(loggedIn);
      }),
      http.get(u("/dashboard/*"), () => HttpResponse.json({}, { status: 404 })),
    );
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/), "secret-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Two-factor authentication" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByText(/6-digit code/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Verification code/), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mfaBody).toEqual({ mfa_token: "mfa-xyz", code: "123456" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Two-factor authentication" })).not.toBeInTheDocument());
  });

  it("shows an invalid code error from the MFA step", async () => {
    server.use(
      noSession,
      http.post(u("/auth/login"), () => HttpResponse.json({ access_token: null, token_type: "bearer", expires_in: null, mfa_required: true, mfa_token: "mfa-xyz", user: null })),
      http.post(u("/auth/login/mfa"), () =>
        HttpResponse.json({ error: { code: "unauthorized", message: "Invalid verification code", details: null, request_id: null } }, { status: 401 })),
    );
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText(/^Email/), "admin@example.com");
    await user.type(screen.getByLabelText(/^Password/), "secret-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText(/Verification code/), "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Invalid verification code")).toBeInTheDocument();
  });
});
