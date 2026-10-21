import * as React from "react";
import { BrowserRouter } from "react-router-dom";
import { AppProviders, createQueryClient } from "@/AppProviders";
import { AppRoutes } from "@/routes/AppRoutes";

export default function App() {
  const [client] = React.useState(createQueryClient);
  return (
    <BrowserRouter>
      <AppProviders client={client}>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  );
}
