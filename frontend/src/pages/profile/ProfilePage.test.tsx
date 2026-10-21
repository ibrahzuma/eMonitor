import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProfilePage } from "@/pages/profile/ProfilePage";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(() => Promise.resolve("data:image/png;base64,QRDATA")) },
}));

describe("ProfilePage two-factor setup", () => {
  it("shows the QR code and secret, then enables 2FA with the entered code", async () => {
    let enableBody: unknown = null;
    server.use(
      http.get(u("/auth/sessions"), () => HttpResponse.json([])),
      http.post(u("/auth/2fa/setup"), () => HttpResponse.json({ secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/eMonitor:admin@example.com?secret=JBSWY3DPEHPK3PXP" })),
      http.post(u("/auth/2fa/enable"), async ({ request }) => {
        enableBody = await request.json();
        return HttpResponse.json({ message: "Two-factor authentication enabled" });
      }),
    );
    const { user } = await renderAuthed(<ProfilePage />, { route: "/profile" });
    await user.click(await screen.findByRole("button", { name: "Set up two-factor authentication" }));
    const img = await screen.findByAltText(/QR code for two-factor/);
    expect(img).toHaveAttribute("src", "data:image/png;base64,QRDATA");
    expect(screen.getByTestId("totp-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");
    const enableBtn = screen.getByRole("button", { name: "Enable 2FA" });
    expect(enableBtn).toBeDisabled();
    await user.type(screen.getByLabelText(/Verification code/), "123456");
    await user.click(enableBtn);
    await waitFor(() => expect(enableBody).toEqual({ code: "123456" }));
  });
});
