/**
 * State routes — /api/state, /api/logs, /ws/state.
 *
 * In standalone mode we synthesize a partial AppState snapshot from disk
 * (live-state.json, paper-state.json, remote-state.json) plus live market
 * data from BinanceService. When the dashboard is run in-process with the
 * orchestrator (future iteration), this same endpoint will return the
 * orchestrator's last emitted state verbatim.
 */

import type { Express } from "express";
import type { WebSocketServer, WebSocket } from "ws";
import type { DashboardContext } from "../context.js";

export function registerStateRoutes(app: Express, ctx: DashboardContext): void {
  // /api/state — best-effort live snapshot for the cockpit status bar.
  app.get("/api/state", async (_req, res, next) => {
    try {
      const killSwitch = ctx.risk.killSwitch.state();
      const venue = ctx.binance.getVenueStatus?.() ?? null;
      const wsStatus = ctx.binance.getWsStatus?.() ?? null;
      const apiWeight = ctx.binance.getApiWeight?.() ?? 0;

      // Account: prefer remote (live) > paper > zero
      let account: { equity: number; marginUsed: number; initialEquity: number } = {
        equity: 0,
        marginUsed: 0,
        initialEquity: 0,
      };
      let positions: unknown[] = [];
      let mode: string = ctx.config.mode;

      const liveState = ctx.readJsonFile<{
        positions?: unknown[];
        mode?: string;
      }>("live-state.json");
      const paperState = ctx.readJsonFile<{
        account?: { equity: number; marginUsed: number; initialEquity: number };
        positions?: unknown[];
        mode?: string;
      }>("paper-state.json");
      const remoteState = ctx.readJsonFile<{
        positions?: Record<string, unknown>;
        closedTrades?: unknown[];
      }>("remote-state.json");

      if (paperState?.account) {
        account = paperState.account;
      }
      if (Array.isArray(liveState?.positions) && liveState.positions.length) {
        positions = liveState.positions;
        mode = "live";
      } else if (Array.isArray(paperState?.positions)) {
        positions = paperState.positions;
        mode = "paper";
      } else if (remoteState?.positions) {
        positions = Object.values(remoteState.positions);
      }

      const state = {
        mode,
        ...account,
        upnl: 0, // requires mark price sync; future iteration
        positions,
        agents: [], // populated in-process
        logs: [],
        killSwitch,
        venue,
        wsStatus,
        apiWeight,
        serverTime: Date.now(),
        symbols: ctx.symbols,
      };
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  // /api/logs — recent audit events (the persisted tail of events.audit.jsonl).
  app.get("/api/logs", (req, res) => {
    const limit = clamp(parseInt(String(req.query.limit ?? "100"), 10), 1, 1000);
    const events = ctx.readJsonlTail<{
      id?: string;
      at: number;
      type?: string;
      decisionId?: string;
      symbol?: string;
      payload?: unknown;
    }>("events.audit.jsonl", limit);
    res.json(events);
  });
}

// Attach /ws/state — in standalone mode, we forward BinanceService mark/tick
// events to subscribers; when run in-process, we'll forward orchestrator
// state/log/sync events directly.
export function attachStateWebSocket(
  wss: WebSocketServer,
  ctx: DashboardContext,
): void {
  wss.on("connection", (ws: WebSocket) => {
    // Send a hello frame so the client can confirm the socket is live.
    ws.send(
      JSON.stringify({
        type: "hello",
        at: Date.now(),
        mode: "standalone",
        symbols: ctx.symbols,
      }),
    );

    // Forward BinanceService feed-health updates (one per second max).
    let lastSent = 0;
    const interval = setInterval(() => {
      const now = Date.now();
      if (now - lastSent < 1000) return;
      lastSent = now;

      try {
        const wsStatus = ctx.binance.getWsStatus?.() ?? null;
        const apiWeight = ctx.binance.getApiWeight?.() ?? 0;
        const venue = ctx.binance.getVenueStatus?.() ?? null;
        ws.send(
          JSON.stringify({
            type: "tick",
            at: now,
            wsStatus,
            apiWeight,
            venue,
          }),
        );
      } catch {
        // socket may have closed
      }
    }, 1000);

    ws.on("close", () => clearInterval(interval));
    ws.on("error", () => clearInterval(interval));
  });
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
