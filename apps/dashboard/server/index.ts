/**
 * Dashboard server — a read-only HTTP/WebSocket layer over the existing
 * crypto-trading-agent data plane.
 *
 * Design rules (per OpenTerminal reuse audit):
 *  - One authoritative futures-data pipeline: we re-instantiate the agent's
 *    BinanceService (read-only public market data) — we do NOT add a second
 *    market-data source for the trading engine to consume.
 *  - Persisted state (decisions, kill-switch, paper/remote/live book,
 *    position-manager, research) is read from disk files the orchestrator
 *    already writes atomically; we never write to them.
 *  - All endpoints are GET-only or read-only POSTs (e.g. backtest with
 *    in-memory ReplayService). No order placement, no risk-gate bypass,
 *    no kill-switch toggle from the dashboard.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { registerStateRoutes, attachStateWebSocket } from "./routes/state.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerRiskRoutes } from "./routes/risk.js";
import { registerDecisionRoutes } from "./routes/decisions.js";
import { registerResearchRoutes } from "./routes/research.js";
import { registerLiveReadinessRoutes } from "./routes/live-readiness.js";
import { registerAccountRoutes } from "./routes/account.js";
import { createDashboardContext, type DashboardContext } from "./context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const dataDir = process.env.CTA_DATA_DIR ?? path.join(repoRoot, "data");
const port = Number(process.env.CTA_DASHBOARD_PORT ?? 4101);
const symbols = (process.env.CTA_SYMBOLS ?? "BTCUSDT,ETHUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function bootstrap(): Promise<void> {
  const ctx: DashboardContext = await createDashboardContext({
    repoRoot,
    dataDir,
    symbols,
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  // CORS — the dashboard front-end runs on a different port in dev.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Health probe — used by the front-end'status bar.
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mode: "read-only",
      dataDir,
      symbols,
      generatedAt: Date.now(),
    });
  });

  // Read-only data routes.
  registerStateRoutes(app, ctx);
  registerMarketRoutes(app, ctx);
  registerRiskRoutes(app, ctx);
  registerDecisionRoutes(app, ctx);
  registerResearchRoutes(app, ctx);
  registerLiveReadinessRoutes(app, ctx);
  registerAccountRoutes(app, ctx);

  // Static front-end (production build). In dev, Vite serves the front-end
  // itself on port 5173 with a proxy to /api here.
  const webDist = path.join(here, "..", "dist-web");
  app.use(express.static(webDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });

  // Unified error handler — never leak stack traces to clients.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : "internal error";
    console.error("[dashboard] error:", msg);
    res.status(500).json({ error: "internal_error", message: msg });
  });

  const server = http.createServer(app);

  // /ws/state — streams orchestrator-equivalent state deltas. In standalone
  // mode we forward the BinanceService WebSocket ticks; when run in-process
  // with the orchestrator (future iteration), we forward orchestrator events.
  const wss = new WebSocketServer({ server, path: "/ws/state" });
  attachStateWebSocket(wss, ctx);

  server.listen(port, () => {
    console.log(
      `[dashboard] read-only server on http://localhost:${port} (data=${dataDir}, symbols=${symbols.join(",")})`,
    );
  });
}

bootstrap().catch((err) => {
  console.error("[dashboard] fatal:", err);
  process.exit(1);
});
