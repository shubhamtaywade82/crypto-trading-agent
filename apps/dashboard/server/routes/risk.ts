/**
 * Risk routes — kill-switch, equity HWM, performance snapshot, approvals,
 * unprotected positions, RR profile, static risk limits.
 *
 * The dashboard is read-only. There is NO endpoint to toggle the kill-switch,
 * reset the HWM, or modify risk limits — operators must use the authenticated
 * CLI command path.
 */

import path from "node:path";
import type { Express } from "express";
import type { DashboardContext } from "../context.js";

export function registerRiskRoutes(app: Express, ctx: DashboardContext): void {
  // /api/risk/snapshot — circuit, performance snapshot, peak equity, limits
  app.get("/api/risk/snapshot", async (_req, res, next) => {
    try {
      const killSwitch = ctx.risk.killSwitch.state();
      const hwm = ctx.risk.equityHwm.forMode?.(ctx.config.mode) ?? null;
      const peak = ctx.risk.equityHwm.peak?.(ctx.config.mode) ?? 0;
      const peakResetAt = ctx.risk.equityHwm.resetAt?.(ctx.config.mode) ?? null;

      // Trades — pull from disk + remote
      const remoteState = ctx.readJsonFile<{
        closedTrades?: unknown[];
      }>("remote-state.json");
      const trades = (remoteState?.closedTrades ?? []) as Parameters<
        typeof ctx.risk.performance.snapshot
      >[0];

      const account = ctx.binance.getAccount?.() ?? { equity: 0 };
      const built = ctx.risk.riskOps.build(trades, account);
      const snapshot = ctx.risk.performance.snapshot(account.equity);

      res.json({
        killSwitch,
        hwm,
        peak,
        peakResetAt,
        limits: ctx.risk.limits,
        circuit: built.circuit,
        performance: snapshot,
      });
    } catch (err) {
      next(err);
    }
  });

  // /api/risk/kill-switch
  app.get("/api/risk/kill-switch", (_req, res) => {
    res.json(ctx.risk.killSwitch.state());
  });

  // /api/risk/limits — static envelope from config
  app.get("/api/risk/limits", (_req, res) => {
    res.json(ctx.risk.limits);
  });

  // /api/risk/approvals — raw approvals.json
  app.get("/api/risk/approvals", (_req, res) => {
    const approvalsPath = path.join(ctx.dataDir, "approvals.json");
    const raw = ctx.risk.loadApprovals(approvalsPath);
    res.json({ approvedStrategies: Array.from(raw), path: approvalsPath });
  });

  // /api/risk/hwm — raw risk-hwm.json
  app.get("/api/risk/hwm", (_req, res) => {
    const raw = ctx.readJsonFile("risk-hwm.json");
    res.json(raw);
  });

  // /api/risk/unprotected?pct=2.5 — find unprotected positions
  app.get("/api/risk/unprotected", async (req, res, next) => {
    try {
      const pct = clamp(Number(req.query.pct ?? 2.5), 0, 100);
      const positions = (await ctx.binance.getPositions(false)) ?? [];
      const equity = ctx.binance.getAccount?.()?.equity ?? 0;
      const result = ctx.risk.findUnprotected(positions, equity, pct / 100);
      res.json({ pct, positions: result, equity });
    } catch (err) {
      next(err);
    }
  });

  // /api/risk/rr-profile — per-strategy RR floors
  app.get("/api/risk/rr-profile", (_req, res) => {
    const rrPath = path.join(ctx.dataDir, "rr-profile.json");
    try {
      const profile = ctx.risk.loadRrProfile(rrPath);
      res.json(profile);
    } catch {
      res.json(null);
    }
  });
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
