/**
 * Dashboard context — bridges the read-only dashboard server to the agent's
 * existing data plane. Everything here is read-only: we re-instantiate the
 * agent's BinanceService for live public market data, and we read the disk
 * files the orchestrator writes (decisions.jsonl, kill-switch.json,
 * paper-state.json, remote-state.json, live-state.json, position-manager.json,
 * research files). We never write to them.
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Re-use the agent's existing implementations — do not duplicate them.
// These imports point at the parent project's src/ tree. tsx resolves them
// at runtime via the parent project's tsconfig.
import { BinanceService } from "../../../src/binance/client.js";
import { MarketStateBuilder } from "../../../src/market/MarketStateBuilder.js";
import { MarketDataService } from "../../../src/market/MarketDataService.js";
import { assessSafety } from "../../../src/market/MarketSafety.js";
import { loadDecisionFiles } from "../../../src/decision/loadDecisionFiles.js";
import {
  evaluateEvidence,
  evaluateForward,
  evaluateConfig,
  approvable,
  isReady,
} from "../../../src/ops/liveReadiness.js";
import { KillSwitch } from "../../../src/ops/killSwitch.js";
import { config as agentConfig } from "../../../src/config.js";
import { loadDashboardData } from "../../../src/ui/researchDashboard.js";
import { ChampionRegistry } from "../../../src/research/ChampionRegistry.js";
import { ExperimentStore } from "../../../src/research/ExperimentStore.js";
import { RiskOps } from "../../../src/runtime/opsHooks.js";
import { EquityHwmStore } from "../../../src/risk/equityHwm.js";
import { PerformanceEngine } from "../../../src/risk/performanceEngine.js";
import { loadApprovals } from "../../../src/risk/strategyApprovals.js";
import { loadRrProfile } from "../../../src/risk/rrProfile.js";
import { findUnprotected } from "../../../src/risk/unprotected.js";
import { riskLimitsFromConfig } from "../../../src/risk/riskConfig.js";
import { LiveBook } from "../../../src/binance/liveBook.js";
import { RemoteStore } from "../../../src/binance/remoteState.js";
import { PaperEngine } from "../../../src/binance/paperEngine.js";
import { PositionManagerStore } from "../../../src/position/PositionManagerStore.js";
import { pmConfigFromEnv } from "../../../src/position/pmConfig.js";
import type { Position, TradeRecord } from "../../../src/types.js";

export interface DashboardContextOptions {
  repoRoot: string;
  dataDir: string;
  symbols: string[];
}

export interface DashboardContext {
  repoRoot: string;
  dataDir: string;
  symbols: string[];
  config: typeof agentConfig;
  // Live market data — read-only, re-instantiated from the agent's source.
  binance: BinanceService;
  marketStateBuilder: MarketStateBuilder;
  marketDataService: MarketDataService;
  assessSafety: typeof assessSafety;
  // Risk and live-readiness accessors — call the agent's pure functions.
  liveReadiness: {
    evaluateEvidence: typeof evaluateEvidence;
    evaluateForward: typeof evaluateForward;
    evaluateConfig: typeof evaluateConfig;
    approvable: typeof approvable;
    isReady: typeof isReady;
  };
  risk: {
    killSwitch: KillSwitch;
    equityHwm: EquityHwmStore;
    performance: PerformanceEngine;
    riskOps: typeof RiskOps;
    limits: ReturnType<typeof riskLimitsFromConfig>;
    loadApprovals: typeof loadApprovals;
    loadRrProfile: typeof loadRrProfile;
    findUnprotected: typeof findUnprotected;
  };
  decisions: {
    loadDecisionFiles: typeof loadDecisionFiles;
    defaultSpec: () => string;
  };
  research: {
    loadDashboardData: typeof loadDashboardData;
    champion: ChampionRegistry;
    experiments: ExperimentStore;
  };
  execution: {
    paper: PaperEngine;
    remote: RemoteStore;
    liveBook: LiveBook;
    positionManager: PositionManagerStore;
    pmConfig: ReturnType<typeof pmConfigFromEnv>;
  };
  // Helpers for disk reads.
  readJsonFile: <T>(relativePath: string) => T | null;
  readJsonlTail: <T>(relativePath: string, limit: number) => T[];
  // Bridge for in-memory store updates (no-op in standalone mode; populated
  // when the dashboard is embedded in the orchestrator process in a future
  // iteration).
  latestAppState: () => null;
}

export async function createDashboardContext(
  opts: DashboardContextOptions,
): Promise<DashboardContext> {
  const { repoRoot, dataDir, symbols } = opts;

  // BinanceService is constructed the same way the agent constructs it.
  // Public market data does not require API keys; the dashboard will not
  // place orders, so we never load trading-capable credentials here.
  const binance = new BinanceService(symbols, agentConfig);
  await binance.initVenue?.();

  const marketStateBuilder = new MarketStateBuilder();
  const marketDataService = new MarketDataService(binance);

  const killSwitch = new KillSwitch(path.join(dataDir, "kill-switch.json"));
  const equityHwm = new EquityHwmStore(path.join(dataDir, "risk-hwm.json"));
  const performance = new PerformanceEngine();

  const champion = new ChampionRegistry(path.join(dataDir, "champion-registry.json"));
  const experiments = new ExperimentStore(path.join(dataDir, "experiments.jsonl"));

  const paper = new PaperEngine(path.join(dataDir, "paper-state.json"));
  const remote = new RemoteStore(path.join(dataDir, "remote-state.json"));
  const liveBook = new LiveBook(path.join(dataDir, "live-state.json"));
  const positionManager = new PositionManagerStore(
    path.join(dataDir, "position-manager.json"),
  );
  const pmConfig = pmConfigFromEnv();

  const limits = riskLimitsFromConfig(agentConfig);

  const readJsonFile = <T>(relativePath: string): T | null => {
    const full = path.join(dataDir, relativePath);
    if (!existsSync(full)) return null;
    try {
      return JSON.parse(readFileSync(full, "utf8")) as T;
    } catch {
      return null;
    }
  };

  const readJsonlTail = <T>(relativePath: string, limit: number): T[] => {
    const full = path.join(dataDir, relativePath);
    if (!existsSync(full)) return [];
    try {
      const raw = readFileSync(full, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      const tail = lines.slice(-limit);
      return tail.map((l) => JSON.parse(l) as T);
    } catch {
      return [];
    }
  };

  const defaultSpec = () => path.join(dataDir, "decisions.jsonl");

  return {
    repoRoot,
    dataDir,
    symbols,
    config: agentConfig,
    binance,
    marketStateBuilder,
    marketDataService,
    assessSafety,
    liveReadiness: {
      evaluateEvidence,
      evaluateForward,
      evaluateConfig,
      approvable,
      isReady,
    },
    risk: {
      killSwitch,
      equityHwm,
      performance,
      riskOps: RiskOps,
      limits,
      loadApprovals,
      loadRrProfile,
      findUnprotected,
    },
    decisions: {
      loadDecisionFiles,
      defaultSpec,
    },
    research: {
      loadDashboardData,
      champion,
      experiments,
    },
    execution: {
      paper,
      remote,
      liveBook,
      positionManager,
      pmConfig,
    },
    readJsonFile,
    readJsonlTail,
    latestAppState: () => null,
  };
}

// Re-exports for use in route modules.
export type { Position, TradeRecord };
