import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppProviders, createQueryClient } from "@/AppProviders";
import { useAuth } from "@/features/auth/AuthProvider";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status !== "authenticated") return <p>auth:{status}</p>;
  return <>{children}</>;
}

/**
 * Render a component inside all providers once the (mocked) session is authenticated.
 * `path` is the route pattern (e.g. "/servers/:id") and `route` the URL to render.
 */
export async function renderAuthed(ui: React.ReactElement, { route = "/", path = "*" }: { route?: string; path?: string } = {}) {
  const client = createQueryClient();
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <AppProviders client={client}>
        <AuthGate>
          <Routes>
            <Route path={path} element={ui} />
            {path !== "*" && <Route path="*" element={<p>navigated-away</p>} />}
          </Routes>
        </AuthGate>
      </AppProviders>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText(/^auth:/)).not.toBeInTheDocument());
  return { ...result, user, client };
}
