/**
 * Decision routes — the decision journal is the canonical audit trail of
 * every gated signal (EXECUTED, RISK_REJECTED, VETOED, EQ_REJECTED,
 * EXECUTION_REFUSED, EXECUTION_FAILED).
 *
 * Filters mirror scripts/analyze-decisions.ts. Refusal summary mirrors
 * src/decision/NoTrade.ts:classifyRiskRefusal.
 */

import type { Express } from "express";
import type { DashboardContext } from "../context.js";
import type { DecisionRecord, DecisionStatus } from "../../../src/decision/DecisionJournal.js";
import { classifyRiskRefusal, NO_TRADE_REASONS } from "../../../src/decision/NoTrade.js";

export function registerDecisionRoutes(app: Express, ctx: DashboardContext): void {
  // /api/decisions?status=&strategy=&symbol=&limit=&spec=
  // spec can be a comma-separated list of files (same shape as
  // loadDecisionFiles).
  app.get("/api/decisions", async (req, res, next) => {
    try {
      const spec = (req.query.spec as string | undefined) ?? ctx.decisions.defaultSpec();
      const all = ctx.decisions.loadDecisionFiles(spec);
      const status = req.query.status as DecisionStatus | undefined;
      const strategy = req.query.strategy as string | undefined;
      const symbol = req.query.symbol as string | undefined;
      const limit = clamp(parseInt(String(req.query.limit ?? "200"), 10), 1, 5000);

      let filtered = all;
      if (status) filtered = filtered.filter((d) => d.status === status);
      if (strategy) filtered = filtered.filter((d) => d.signal.strategy === strategy);
      if (symbol) filtered = filtered.filter((d) => d.signal.symbol === symbol);

      // newest first
      const sorted = [...filtered].sort((a, b) => b.timestamp - a.timestamp);
      res.json(sorted.slice(0, limit));
    } catch (err) {
      next(err);
    }
  });

  // /api/decisions/:id
  app.get("/api/decisions/:id", async (req, res, next) => {
    try {
      const all = ctx.decisions.loadDecisionFiles(ctx.decisions.defaultSpec());
      const found = all.find((d) => d.decisionId === req.params.id);
      if (!found) return res.status(404).json({ error: "not_found" });
      res.json(found);
    } catch (err) {
      next(err);
    }
  });

  // /api/decisions/refusals/summary — counts by refusal reason
  app.get("/api/decisions/refusals/summary", async (_req, res, next) => {
    try {
      const all = ctx.decisions.loadDecisionFiles(ctx.decisions.defaultSpec());
      const rejected = all.filter(
        (d) =>
          d.status === "RISK_REJECTED" ||
          d.status === "VETOED" ||
          d.status === "EQ_REJECTED" ||
          d.status === "EXECUTION_REFUSED" ||
          d.status === "EXECUTION_FAILED",
      ) as (DecisionRecord & { reason?: string })[];

      const counts: Record<string, number> = {};
      for (const reason of NO_TRADE_REASONS) counts[reason] = 0;
      counts.OTHER = 0;
      for (const r of rejected) {
        const code = classifyRiskRefusal(r);
        counts[code] = (counts[code] ?? 0) + 1;
      }
      res.json({ total: rejected.length, counts });
    } catch (err) {
      next(err);
    }
  });

  // /api/decisions/status/summary — counts by status
  app.get("/api/decisions/status/summary", async (_req, res, next) => {
    try {
      const all = ctx.decisions.loadDecisionFiles(ctx.decisions.defaultSpec());
      const counts: Record<string, number> = {};
      for (const d of all) counts[d.status] = (counts[d.status] ?? 0) + 1;
      res.json({ total: all.length, counts });
    } catch (err) {
      next(err);
    }
  });
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
