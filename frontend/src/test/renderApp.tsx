import { render, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AppProviders, createQueryClient } from "@/AppProviders";
import { AppRoutes } from "@/routes/AppRoutes";

/** Render the whole application at `route` (session restored via the mocked /auth/refresh). */
export function renderApp(route = "/"): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const client = createQueryClient();
  const user = userEvent.setup();
  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <AppProviders client={client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { ...result, user };
}

