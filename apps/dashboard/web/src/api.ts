/**
 * HTTP + WS client. All fetches go through `requestJson` so the panels can
 * share a single error-handling path. The WS client auto-reconnects with
 * exponential backoff.
 */

import { useDashboardStore } from "./store.js";

const BASE = "";

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

type WsMessage =
  | { type: "hello"; at: number; mode: string; symbols: string[] }
  | { type: "tick"; at: number; wsStatus: unknown; apiWeight: number; venue: unknown };

export function startWebSocket(): () => void {
  let closed = false;
  let reconnectDelayMs = 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/state`;

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(url);
    socket.onopen = () => {
      reconnectDelayMs = 500;
      useDashboardStore.getState().setWs({ connected: true, mode: "connecting" });
    };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage;
        if (msg.type === "hello") {
          useDashboardStore.getState().setWs({
            connected: true,
            mode: msg.mode,
            symbols: msg.symbols,
            lastAt: msg.at,
          });
        } else if (msg.type === "tick") {
          useDashboardStore.getState().setWs({
            connected: true,
            lastAt: msg.at,
            apiWeight: msg.apiWeight,
            wsStatus: msg.wsStatus,
            venue: msg.venue,
          });
        }
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      useDashboardStore.getState().setWs({ connected: false });
      if (closed) return;
      timer = setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(8000, reconnectDelayMs * 2);
    };
    socket.onerror = () => {
      socket?.close();
    };
  };
  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
