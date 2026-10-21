import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { resourcesApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { resourcePath } from "@/utils/status";

/** /resources/:id — resolve the resource kind and redirect to its detail page. */
export function ResourceRedirect() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: qk.resource(id), queryFn: () => resourcesApi.get(id), enabled: Boolean(id) });
  if (q.isLoading) return <LoadingState label="Opening resource…" />;
  if (q.isError || !q.data) return <ErrorState error={q.error ?? new Error("Resource not found")} onRetry={() => void q.refetch()} title="Could not open resource" />;
  return <Navigate replace to={resourcePath(q.data.kind, q.data.id)} />;
}
