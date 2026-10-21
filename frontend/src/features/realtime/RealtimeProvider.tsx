import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { tokenStore, wsUrl } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { useAuth } from "@/features/auth/AuthProvider";
import type { WsMessage } from "@/types/api";

export type RealtimeStatus = "connecting" | "connected" | "disconnected";
type Listener = (msg: WsMessage) => void;

interface RealtimeCtx {
  status: RealtimeStatus;
  send: (msg: Record<string, unknown>) => boolean;
  subscribe: (l: Listener) => () => void;
}

const Ctx = React.createContext<RealtimeCtx>({
  status: "disconnected",
  send: () => false,
  subscribe: () => () => undefined,
});

/** Invalidate cached queries affected by a live event. */
export function invalidateForEvent(qc: QueryClient, msg: WsMessage): void {
  switch (msg.type) {
    case "incident":
      void qc.invalidateQueries({ queryKey: qk.incidents });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
      void qc.invalidateQueries({ queryKey: qk.resources });
      break;
    case "resource_status":
    case "check_state":
      void qc.invalidateQueries({ queryKey: qk.resources });
      void qc.invalidateQueries({ queryKey: qk.checks });
      void qc.invalidateQueries({ queryKey: qk.dashboard });
      break;
    case "metrics":
      void qc.invalidateQueries({ queryKey: qk.metrics });
      void qc.invalidateQueries({ queryKey: ["resources", "list"] });
      break;
    case "notification":
      void qc.invalidateQueries({ queryKey: qk.inbox });
      void qc.invalidateQueries({ queryKey: ["notifications", "deliveries"] });
      break;
    default:
      break;
  }
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { status: authStatus, orgId } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<RealtimeStatus>("disconnected");
  const wsRef = React.useRef<WebSocket | null>(null);
  const listeners = React.useRef(new Set<Listener>());

  React.useEffect(() => {
    if (authStatus !== "authenticated" || !orgId || typeof WebSocket === "undefined") return;
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;
    let pingTimer: number | undefined;
    let readyAt = 0;

    const connect = () => {
      if (stopped) return;
      const token = tokenStore.get();
      if (!token) {
        timer = window.setTimeout(connect, 2000);
        return;
      }
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token, organization_id: orgId }));
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(ev.data) as WsMessage;
        } catch {
          return;
        }
        if (msg.type === "ready") {
          readyAt = Date.now();
          setStatus("connected");
          window.clearInterval(pingTimer);
          pingTimer = window.setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
          }, 25000);
        }
        invalidateForEvent(qc, msg);
        listeners.current.forEach((l) => l(msg));
      };
      ws.onclose = () => {
        window.clearInterval(pingTimer);
        // Only reset the backoff when the connection was healthy for a while (avoids reconnect storms when the
        // server accepts the socket and drops it right after "ready").
        if (readyAt && Date.now() - readyAt > 30000) attempt = 0;
        readyAt = 0;
        if (wsRef.current === ws) wsRef.current = null;
        setStatus("disconnected");
        scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 500;
      timer = window.setTimeout(connect, delay);
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(pingTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      setStatus("disconnected");
    };
  }, [authStatus, orgId, qc]);

  const send = React.useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  const subscribe = React.useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => {
      listeners.current.delete(l);
    };
  }, []);

  const value = React.useMemo(() => ({ status, send, subscribe }), [status, send, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeCtx {
  return React.useContext(Ctx);
}

/** Polling interval for live data: poll every 30s when the WebSocket is down, slower when live events flow. */
export function useLiveInterval(connectedMs: number | false = false, disconnectedMs = 30000): number | false {
  const { status } = useRealtime();
  return status === "connected" ? connectedMs : disconnectedMs;
}
