import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { orgStore, tokenStore } from "@/api/client";
import { server } from "@/test/server";

// jsdom gaps used by Radix UI / Recharts
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverMock });

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => undefined);
Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => undefined);

// No WebSocket in tests: the realtime provider falls back to polling.
Object.assign(globalThis, { WebSocket: undefined });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

beforeEach(() => {
  document.cookie = "emonitor_csrf=test-csrf; path=/";
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  orgStore.set(null);
  tokenStore.set(null);
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => server.close());
