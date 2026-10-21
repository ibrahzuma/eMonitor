import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { makeMe } from "@/test/fixtures";

/** Build a URL pattern for an API path, matching any origin (msw wildcard). */
export const u = (path: string) => `*/api/v1${path}`;

export const emptyPage = { items: [], total: 0, page: 1, page_size: 50 };

/** Default handlers: an authenticated session (refresh succeeds) and empty collections. */
export const defaultHandlers = [
  http.post(u("/auth/refresh"), () =>
    HttpResponse.json({ access_token: "test-token", token_type: "bearer", expires_in: 900, mfa_required: false, mfa_token: null, user: makeMe().user })),
  http.get(u("/auth/me"), () => HttpResponse.json(makeMe())),
  http.post(u("/auth/logout"), () => HttpResponse.json({ message: "Logged out" })),
  http.get(u("/notifications/inbox"), () => HttpResponse.json({ items: [], unread: 0 })),
  http.get(u("/groups"), () => HttpResponse.json([])),
  http.get(u("/teams"), () => HttpResponse.json([])),
  http.get(u("/users"), () => HttpResponse.json(emptyPage)),
  http.get(u("/notifications/policies"), () => HttpResponse.json([])),
  http.get(u("/notifications/channels"), () => HttpResponse.json([])),
  http.get(u("/resources"), () => HttpResponse.json(emptyPage)),
  http.get(u("/incidents"), () => HttpResponse.json(emptyPage)),
];

export const server = setupServer(...defaultHandlers);

export { http, HttpResponse };
