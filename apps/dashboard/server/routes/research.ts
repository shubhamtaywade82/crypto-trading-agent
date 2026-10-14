/**
 * Research routes — champion registry, experiments, events, metrics, and the
 * canonical DashboardData shape produced by loadDashboardData(dataDir).
 *
 * This is the same read-only accessor the Ink research-dashboard TUI uses;
 * the web cockpit consumes the identical object.
 */

import type { Express } from "express";
import type { DashboardContext } from "../context.js";

export function registerResearchRoutes(app: Express, ctx: DashboardContext): void {
  // /api/research/dashboard — full DashboardData
  app.get("/api/research/dashboard", (_req, res, next) => {
    try {
      const data = ctx.research.loadDashboardData(ctx.dataDir);
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // /api/research/champion — ChampionRegistry.snapshot()
  app.get("/api/research/champion", (_req, res) => {
    res.json(ctx.research.champion.snapshot());
  });

  // /api/research/experiments?limit=
  app.get("/api/research/experiments", (req, res) => {
    const limit = clamp(parseInt(String(req.query.limit ?? "200"), 10), 1, 5000);
    const all = ctx.research.experiments.all();
    // newest first
    const sorted = [...all].sort((a, b) => b.ranAt - a.ranAt);
    res.json(sorted.slice(0, limit));
  });

  // /api/research/events?limit=
  app.get("/api/research/events", (req, res) => {
    const limit = clamp(parseInt(String(req.query.limit ?? "200"), 10), 1, 5000);
    const events = ctx.readJsonlTail<{
      seq: number;
      at: number;
      type: string;
      payload?: unknown;
    }>("research-events.jsonl", limit);
    res.json(events);
  });

  // /api/research/metrics — metrics snapshot rebuilt from events on disk
  app.get("/api/research/metrics", (_req, res, next) => {
    try {
      const data = ctx.research.loadDashboardData(ctx.dataDir);
      // DashboardData already includes the rebuilt metrics snapshot
      res.json((data as { metrics?: unknown }).metrics ?? null);
    } catch (err) {
      next(err);
    }
  });

  // /api/research/experiment-memory — embeddings memory
  app.get("/api/research/experiment-memory", (_req, res, next) => {
    try {
      // ExperimentMemory is loaded from data/experiment-memory.json (atomic).
      const raw = ctx.readJsonFile("experiment-memory.json");
      res.json(raw);
    } catch (err) {
      next(err);
    }
  });
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
