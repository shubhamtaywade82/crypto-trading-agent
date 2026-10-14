/**
 * Market routes — expose the agent's MarketDataService / MarketStateBuilder /
 * MarketSafety / derivatives pipeline. All read-only.
 *
 * Critically: the dashboard must NOT compute its own market state. We always
 * call the agent's MarketStateBuilder and BinanceService so the chart and
 * the strategy engine see the same numbers.
 */

import type { Express } from "express";
import type { DashboardContext } from "../context.js";

export function registerMarketRoutes(app: Express, ctx: DashboardContext): void {
  // /api/market/snapshot?symbols=BTCUSDT,ETHUSDT — MarketDataService.snapshot
  app.get("/api/market/snapshot", async (req, res, next) => {
    try {
      const symbols = parseSymbols(req.query.symbols as string, ctx.symbols);
      const result = await ctx.marketDataService.snapshot(symbols);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // /api/market/state?symbols=... — MarketStateBuilder.buildAll
  app.get("/api/market/state", async (req, res, next) => {
    try {
      const symbols = parseSymbols(req.query.symbols as string, ctx.symbols);
      const overview = await ctx.binance.getMarketOverview(symbols);
      const inputs = symbols.map((sym) => ({
        symbol: sym,
        candles: overview.candles[sym] ?? overview.marketDataV2[sym]?.candles ?? {},
        derivatives: overview.marketDataV2[sym]?.derivatives ?? null,
        markPrice: overview.marks[sym] ?? null,
        funding: overview.funding[sym] ?? null,
      }));
      const states = ctx.marketStateBuilder.buildAll(inputs);
      res.json(states);
    } catch (err) {
      next(err);
    }
  });

  // /api/market/safety?symbols=... — assessSafety verdicts per symbol
  app.get("/api/market/safety", async (req, res, next) => {
    try {
      const symbols = parseSymbols(req.query.symbols as string, ctx.symbols);
      const overview = await ctx.binance.getMarketOverview(symbols);
      const verdicts: Record<string, unknown> = {};
      for (const sym of symbols) {
        const data = overview.marketDataV2[sym];
        const candles = data?.candles;
        const derivatives = data?.derivatives;
        // Mirror the orchestrator's assessSafety input shape.
        const verdict = ctx.assessSafety({
          symbol: sym,
          generatedAt: data?.generatedAt ?? Date.now(),
          candles: candles ?? {},
          derivatives: derivatives ?? null,
          spreadBps: derivatives?.spreadBps,
        } as never);
        verdicts[sym] = verdict;
      }
      res.json(verdicts);
    } catch (err) {
      next(err);
    }
  });

  // /api/market/derivatives?symbols=...
  app.get("/api/market/derivatives", async (req, res, next) => {
    try {
      const symbols = parseSymbols(req.query.symbols as string, ctx.symbols);
      const overview = await ctx.binance.getMarketOverview(symbols);
      const out: Record<string, unknown> = {};
      for (const sym of symbols) {
        out[sym] = overview.marketDataV2[sym]?.derivatives ?? null;
      }
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // /api/market/feed-health?symbol=BTCUSDT — lastTickAt / markAt / exchangeStatus
  app.get("/api/market/feed-health", (req, res, next) => {
    try {
      const symbol = String(req.query.symbol ?? ctx.symbols[0] ?? "BTCUSDT");
      const health = ctx.binance.getFeedHealth?.(symbol) ?? null;
      res.json({ symbol, health });
    } catch (err) {
      next(err);
    }
  });

  // /api/market/ws-status — BinanceService WebSocket health
  app.get("/api/market/ws-status", (_req, res) => {
    const status = ctx.binance.getWsStatus?.() ?? null;
    res.json(status);
  });
}

function parseSymbols(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
