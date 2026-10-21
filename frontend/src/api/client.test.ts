import { describe, expect, it } from "vitest";
import { ApiError, api, buildQuery, orgStore, refreshSession, tokenStore } from "@/api/client";
import { http, HttpResponse, server, u } from "@/test/server";

describe("api client", () => {
  it("serializes array query params as repeated keys and skips empty values", () => {
    expect(buildQuery({ status: ["critical", "warning"], q: "", page: 2, env: undefined, open: true }))
      .toBe("?status=critical&status=warning&page=2&open=true");
  });

  it("attaches bearer token and organization header", async () => {
    tokenStore.set("abc");
    orgStore.set("org-1");
    let seen: { auth: string | null; org: string | null } = { auth: null, org: null };
    server.use(http.get(u("/organizations/current"), ({ request }) => {
      seen = { auth: request.headers.get("authorization"), org: request.headers.get("x-organization-id") };
      return HttpResponse.json({ id: "org-1" });
    }));
    await api.get("/organizations/current");
    expect(seen).toEqual({ auth: "Bearer abc", org: "org-1" });
  });

  it("refreshes once on 401 and retries the request with the new token", async () => {
    tokenStore.set("expired");
    let calls = 0;
    let refreshCsrf: string | null = null;
    server.use(
      http.post(u("/auth/refresh"), ({ request }) => {
        refreshCsrf = request.headers.get("x-csrf-token");
        return HttpResponse.json({ access_token: "fresh", token_type: "bearer", expires_in: 900, mfa_required: false, mfa_token: null, user: null });
      }),
      http.get(u("/incidents"), ({ request }) => {
        calls += 1;
        if (request.headers.get("authorization") !== "Bearer fresh") {
          return HttpResponse.json({ error: { code: "unauthorized", message: "expired", details: null, request_id: "r1" } }, { status: 401 });
        }
        return HttpResponse.json({ items: [], total: 0, page: 1, page_size: 50 });
      }),
    );
    const res = await api.get<{ total: number }>("/incidents");
    expect(res.total).toBe(0);
    expect(calls).toBe(2);
    expect(refreshCsrf).toBe("test-csrf");
    expect(tokenStore.get()).toBe("fresh");
  });

  it("deduplicates concurrent refreshes", async () => {
    let refreshes = 0;
    server.use(http.post(u("/auth/refresh"), async () => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 20));
      return HttpResponse.json({ access_token: `t${refreshes}`, token_type: "bearer", expires_in: 900, mfa_required: false, mfa_token: null, user: null });
    }));
    const [a, b, c] = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(refreshes).toBe(1);
    expect(a?.access_token).toBe("t1");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("throws the 401 when refresh fails and clears the token", async () => {
    tokenStore.set("expired");
    server.use(
      http.post(u("/auth/refresh"), () => HttpResponse.json({ error: { code: "unauthorized", message: "No session", details: null, request_id: null } }, { status: 401 })),
      http.get(u("/resources"), () => HttpResponse.json({ error: { code: "unauthorized", message: "Authentication required", details: null, request_id: null } }, { status: 401 })),
    );
    await expect(api.get("/resources")).rejects.toMatchObject({ status: 401 });
    expect(tokenStore.get()).toBeNull();
  });

  it("parses structured errors and maps 422 details to field errors", async () => {
    server.use(http.post(u("/servers"), () => HttpResponse.json({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: [{ loc: ["body", "name"], msg: "String should have at least 1 character" },
          { loc: ["body", "checks", 0, "config", "url"], msg: "Value error, URL must use http or https" }],
        request_id: "abc",
      },
    }, { status: 422 })));
    const err = await api.post("/servers", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const e = err as ApiError;
    expect(e.status).toBe(422);
    expect(e.requestId).toBe("abc");
    const fe = e.fieldErrors();
    expect(fe.name).toMatch(/at least 1 character/);
    expect(fe["checks.0.config.url"]).toBe("URL must use http or https");
    expect(fe.url).toBe("URL must use http or https");
  });

  it("exposes Retry-After on 429", async () => {
    server.use(http.get(u("/logs/search"), () => HttpResponse.json(
      { error: { code: "rate_limited", message: "Too many requests", details: null, request_id: null } },
      { status: 429, headers: { "Retry-After": "17" } })));
    const e = (await api.get("/logs/search").catch((x: unknown) => x)) as ApiError;
    expect(e.retryAfter).toBe(17);
    expect(e.describe()).toContain("17s");
  });

  it("produces a generic error for non-JSON 500 responses", async () => {
    server.use(http.get(u("/dashboard/summary"), () => new HttpResponse("boom", { status: 500 })));
    const e = (await api.get("/dashboard/summary").catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(500);
    expect(e.message).toBe("Server error");
  });
});
