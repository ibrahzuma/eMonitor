import { useQueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { Field, Input } from "@/components/ui/input";
import { invalidateForEvent } from "@/features/realtime/RealtimeProvider";
import { fieldErrorsOf, useApiMutation } from "@/hooks/useApi";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";

function GroupForm() {
  const [name, setName] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const m = useApiMutation({
    mutationFn: () => api.post("/groups", { name }),
    success: "Group created",
    errorTitle: "Could not create group",
    onError: (e) => setErrors(fieldErrorsOf(e)),
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <Field label="Group name" htmlFor="g-name" error={errors.name}>
        <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <button type="submit">Create</button>
    </form>
  );
}

describe("API error handling in forms", () => {
  it("maps 422 validation details onto the matching field", async () => {
    server.use(http.post(u("/groups"), () => HttpResponse.json({
      error: { code: "validation_error", message: "Request validation failed", details: [{ loc: ["body", "name"], msg: "String should have at least 1 character" }], request_id: "r" },
    }, { status: 422 })));
    const { user } = await renderAuthed(<GroupForm />);
    await user.click(screen.getByRole("button", { name: "Create" }));
    const err = await screen.findByText("String should have at least 1 character", { selector: "p" });
    expect(err).toHaveAttribute("id", "g-name-error");
    expect(screen.getByLabelText("Group name")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows a toast for 500 server errors", async () => {
    server.use(http.post(u("/groups"), () => HttpResponse.json(
      { error: { code: "internal_error", message: "Internal server error", details: null, request_id: "abc" } }, { status: 500 })));
    const { user } = await renderAuthed(<GroupForm />);
    await user.type(screen.getByLabelText("Group name"), "web");
    await user.click(screen.getByRole("button", { name: "Create" }));
    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("Could not create group");
    expect(toast).toHaveTextContent("Internal server error");
  });

  it("shows a success toast", async () => {
    server.use(http.post(u("/groups"), () => HttpResponse.json({ id: "g1" }, { status: 201 })));
    const { user } = await renderAuthed(<GroupForm />);
    await user.type(screen.getByLabelText("Group name"), "web");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Group created")).toBeInTheDocument();
  });
});

function InvalidationProbe({ onReady }: { onReady: (qc: ReturnType<typeof useQueryClient>) => void }) {
  const qc = useQueryClient();
  React.useEffect(() => onReady(qc), [qc, onReady]);
  return <p>probe</p>;
}

describe("realtime event invalidation", () => {
  it("invalidates incident, dashboard and inbox queries for live events", async () => {
    let client: ReturnType<typeof useQueryClient> | null = null;
    await renderAuthed(<InvalidationProbe onReady={(qc) => { client = qc; }} />);
    await waitFor(() => expect(client).not.toBeNull());
    const qc = client as unknown as ReturnType<typeof useQueryClient>;
    qc.setQueryData(qk.incidentList({}), { items: [] });
    qc.setQueryData(qk.dashboardPart("summary"), {});
    qc.setQueryData(qk.inbox, { items: [], unread: 0 });
    invalidateForEvent(qc, { type: "incident", data: {} });
    expect(qc.getQueryState(qk.incidentList({}))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.dashboardPart("summary"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(qk.inbox)?.isInvalidated).toBe(false);
    invalidateForEvent(qc, { type: "notification", data: {} });
    expect(qc.getQueryState(qk.inbox)?.isInvalidated).toBe(true);
  });
});
