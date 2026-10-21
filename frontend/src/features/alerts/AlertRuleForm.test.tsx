import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlertRuleForm, conditionToPayload, defaultCondition } from "@/features/alerts/AlertRuleForm";
import { http, HttpResponse, server, u } from "@/test/server";
import { renderAuthed } from "@/test/utils";
import type { AlertRule, AlertRuleIn } from "@/types/api";

const existingRule = (id: string, name: string): AlertRule => ({
  id, name, description: "", rule_type: "website_down", target: {}, condition: {}, severity: "critical",
  evaluation_interval_seconds: 60, consecutive_breaches: 1, recovery_consecutive: 1, cooldown_seconds: 300,
  suppress_in_maintenance: true, auto_resolve: true, notification_policy_id: null, enabled: true,
  last_eval_at: null, last_error: "", created_at: "2026-10-20T00:00:00Z", firing: 0,
});

describe("alert rule condition helpers", () => {
  it("builds typed condition payloads and validates", () => {
    expect(conditionToPayload("ssl_expiry", defaultCondition("ssl_expiry"))).toEqual({ days: 14 });
    const errors: Record<string, string> = {};
    conditionToPayload("composite", defaultCondition("composite"), errors);
    expect(errors["condition.rule_ids"]).toMatch(/at least 2/);
  });
});

describe("AlertRuleForm", () => {
  it("switches condition fields by rule type and submits the matching condition", async () => {
    server.use(http.get(u("/alerts/rules"), () => HttpResponse.json([existingRule("r1", "Rule A"), existingRule("r2", "Rule B")])));
    const onSubmit = vi.fn<(p: AlertRuleIn) => void>();
    const { user } = await renderAuthed(<AlertRuleForm onSubmit={onSubmit} />);

    // default: metric threshold
    expect(screen.getByLabelText(/^Metric/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Threshold/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Days before expiry/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Rule type"), "ssl_expiry");
    expect(screen.queryByLabelText(/^Metric/)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Rule type"), "website_down");
    expect(screen.getByText(/No extra condition settings/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Rule type"), "composite");
    expect(screen.getByRole("button", { name: "Rules" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Rule type"), "ssl_expiry");
    const days = screen.getByLabelText(/Days before expiry/);
    await user.clear(days);
    await user.type(days, "21");
    await user.type(screen.getByLabelText(/^Name/), "Certificates expiring");
    await user.click(screen.getByRole("button", { name: "Create rule" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.rule_type).toBe("ssl_expiry");
    expect(payload.name).toBe("Certificates expiring");
    expect(payload.condition).toEqual({ days: 21 });
    expect(payload.target).toEqual({ resource_ids: [], group_ids: [], check_ids: [], tags: [], kinds: [], environments: [] });
  });

  it("shows validation errors for metric thresholds and does not submit", async () => {
    const onSubmit = vi.fn<(p: AlertRuleIn) => void>();
    const { user } = await renderAuthed(<AlertRuleForm onSubmit={onSubmit} />);
    await user.clear(screen.getByLabelText(/^Threshold/));
    await user.click(screen.getByRole("button", { name: "Create rule" }));
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Threshold is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^Name/), "High CPU");
    await user.type(screen.getByLabelText(/^Threshold/), "85");
    await user.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].condition).toEqual({
      metric: "cpu_percent", aggregation: "avg", operator: "gt", threshold: 85, window_seconds: 300,
    });
  });

  it("locks the rule type when editing", async () => {
    await renderAuthed(<AlertRuleForm rule={existingRule("r1", "Down")} onSubmit={() => undefined} />);
    expect(screen.getByLabelText("Rule type")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save rule" })).toBeInTheDocument();
  });
});
