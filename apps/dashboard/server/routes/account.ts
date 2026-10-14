/**
 * Account / execution / position routes — read-only views over the live
 * BinanceService account, paper engine, remote broker, and position manager.
 *
 * No order placement, no cancel, no reduce-only. The dashboard surfaces
 * what the engine is doing; it never commands it.
 */

import type { Express } from "express";
import type { DashboardContext } from "../context.js";

export function registerAccountRoutes(app: Express, ctx: DashboardContext): void {
  // /api/account — live account (equity, marginUsed, initialEquity)
  app.get("/api/account", async (_req, res, next) => {
    try {
      const account = ctx.binance.getAccount?.() ?? null;
      res.json(account);
    } catch (err) {
      next(err);
    }
  });

  // /api/positions — current open positions
  app.get("/api/positions", async (_req, res, next) => {
    try {
      const positions = (await ctx.binance.getPositions(false)) ?? [];
      res.json(positions);
    } catch (err) {
      next(err);
    }
  });

  // /api/trades?limit= — recent closed trades
  app.get("/api/trades", (req, res, next) => {
    try {
      const limit = clamp(parseInt(String(req.query.limit ?? "100"), 10), 1, 1000);
      const trades = ctx.binance.getTrades?.() ?? [];
      const sorted = [...trades].sort((a, b) => b.closedAt - a.closedAt);
      res.json(sorted.slice(0, limit));
    } catch (err) {
      next(err);
    }
  });

  // /api/venue — venue status (connected / degraded / down)
  app.get("/api/venue", (_req, res) => {
    const status = ctx.binance.getVenueStatus?.() ?? null;
    res.json(status);
  });

  // /api/venue/feed-health?symbol=
  app.get("/api/venue/feed-health", (req, res) => {
    const symbol = String(req.query.symbol ?? ctx.symbols[0] ?? "BTCUSDT");
    const health = ctx.binance.getFeedHealth?.(symbol) ?? null;
    res.json({ symbol, health });
  });

  // /api/venue/ws-status — BinanceService WebSocket health (reconnects etc.)
  app.get("/api/venue/ws-status", (_req, res) => {
    const status = ctx.binance.getWsStatus?.() ?? null;
    res.json(status);
  });

  // /api/live-book — live position manager view (if enabled)
  app.get("/api/live-book", async (_req, res, next) => {
    try {
      const mode = ctx.execution.liveBook.mode ?? "shadow";
      const prices: Record<string, number> = {};
      const overview = await ctx.binance.getMarketOverview(ctx.symbols);
      for (const sym of ctx.symbols) {
        const m = overview.marks[sym] ?? overview.tickers[sym]?.price;
        if (m) prices[sym] = m;
      }
      const positions = ctx.execution.liveBook.positions(prices);
      res.json({ mode, positions });
    } catch (err) {
      next(err);
    }
  });

  // /api/position-manager/states — deterministic PM state machine
  app.get("/api/position-manager/states", (_req, res) => {
    const keys = ctx.execution.positionManager.keys();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = ctx.execution.positionManager.get(k);
      if (v) out[k] = v;
    }
    res.json(out);
  });

  // /api/position-manager/config — pmConfigFromEnv
  app.get("/api/position-manager/config", (_req, res) => {
    res.json(ctx.execution.pmConfig);
  });
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
