/**
 * Live readiness routes — mirrors scripts/live-readiness.ts exactly.
 *
 * Calls evaluateEvidence + evaluateForward + evaluateConfig + approvable +
 * isReady and returns the full check list the operator would see on the CLI.
 */

import path from "node:path";
import type { Express } from "express";
import type { DashboardContext } from "../context.js";
import { liveStartBlockers } from "../../../../src/ops/liveReadiness.js";

export function registerLiveReadinessRoutes(app: Express, ctx: DashboardContext): void {
  // /api/live-readiness — full check
  app.get("/api/live-readiness", async (_req, res, next) => {
    try {
      const evidenceSpec = path.join(ctx.dataDir, "decisions.jsonl");
      const paperSpec = path.join(ctx.dataDir, "decisions.jsonl");
      const records = ctx.decisions.loadDecisionFiles(evidenceSpec);
      const paperRecords = ctx.decisions.loadDecisionFiles(paperSpec);

      const costs = {
        feeRate: ctx.config.risk?.takerFeeRate ?? 0.0005,
        slippageRate: ctx.config.risk?.slippageBufferRate ?? 0.0002,
      };

      const evidence = ctx.liveReadiness.evaluateEvidence(records, costs);
      const forward = ctx.liveReadiness.evaluateForward(paperRecords, costs);

      // Unprotected positions for the OPS check
      const positions = (await ctx.binance.getPositions(false)) ?? [];
      const account = await ctx.binance.getAccount?.();
      const equity = account?.equity ?? 0;
      const unprotected = ctx.risk.findUnprotected(positions, equity, 0.025);

      const checks = ctx.liveReadiness.evaluateConfig({
        mode: ctx.config.mode,
        riskEngine: ctx.config.riskEngine,
        alerts: ctx.config.alerts,
        riskPerTradePct: ctx.config.risk?.riskPerTradePct ?? 0.5,
        maxLeverage: ctx.config.risk?.maxLeverage ?? 5,
        maxDailyLossPct: ctx.config.risk?.maxDailyLossPct ?? 4,
        maxDrawdownPct: ctx.config.risk?.maxDrawdownPct ?? 10,
        killSwitchHalted: ctx.risk.killSwitch.state().halted,
        unprotected,
      });

      const approvableStrategies = ctx.liveReadiness.approvable(evidence, forward);
      const ready = ctx.liveReadiness.isReady(checks);
      const blockers = liveStartBlockers({
        mode: ctx.config.mode,
        riskEngine: ctx.config.riskEngine,
        alerts: ctx.config.alerts,
      });

      res.json({
        ready,
        blockers,
        checks,
        evidence,
        forward,
        approvable: approvableStrategies,
      });
    } catch (err) {
      next(err);
    }
  });
}
