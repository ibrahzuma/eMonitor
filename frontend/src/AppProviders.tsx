import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { ApiError, errorMessage } from "@/api/client";
import { TooltipProvider } from "@/components/ui/menus";
import { pushToast, ToastProvider } from "@/components/ui/toast";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { RealtimeProvider } from "@/features/realtime/RealtimeProvider";
import { ThemeProvider } from "@/hooks/useTheme";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        // Background refetch failures of already-loaded data surface as a toast; first-load errors render inline.
        if (query.state.data !== undefined && !(err instanceof ApiError && err.status === 401)) {
          pushToast({ kind: "error", title: "Refresh failed", description: errorMessage(err) });
        }
      },
    }),
    mutationCache: new MutationCache(),
    defaultOptions: {
      queries: {
        staleTime: 15000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function AppProviders({ children, client }: { children: React.ReactNode; client: QueryClient }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <TooltipProvider delayDuration={250}>
            <AuthProvider>
              <RealtimeProvider>{children}</RealtimeProvider>
            </AuthProvider>
          </TooltipProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
