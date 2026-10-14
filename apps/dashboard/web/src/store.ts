/**
 * Dashboard store — Zustand store mirroring the Ink TUI's useStore pattern.
 * Panels subscribe to slices; the App polls the read-only HTTP endpoints
 * on a 1-second tick (same cadence as the Ink UI's tick flush).
 */

import { create } from "zustand";

export interface SymbolState {
  symbol: string;
  lastPrice: number | null;
  changePct: number | null;
  sparkline: number[] | null;
  fundingPct: number | null;
  spreadBps: number | null;
  safetyLevel: "NORMAL" | "NO_ENTRY" | "HALT" | null;
  safetyReasons: string[];
  stale: boolean;
}

export interface DecisionRow {
  decisionId: string;
  status: string;
  timestamp: number;
  symbol: string;
  strategy: string;
  side: string;
  reason?: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  notionalUsdt?: number;
  refusalReason?: string;
}

export interface PositionRow {
  symbol: string;
  side: string;
  strategy: string;
  entry: number;
  qty: number;
  mark?: number;
  upnl?: number;
  upnlPct?: number;
  leverage?: number;
  marginType?: string;
  liqDistancePct?: number;
  serverSl?: number;
  serverTp?: number;
  decisionId?: string;
}

export interface ResearchSummary {
  champion?: { id: string; version: number };
  challengers?: Array<{ id: string; version: number; stage: string }>;
  experiments?: Array<{ experimentId: string; ranAt: number; verdict: string }>;
  metrics?: Record<string, number>;
}

export interface LiveReadinessCheck {
  area: string;
  id: string;
  status: string;
  detail: string;
}

export interface LiveReadinessResult {
  ready: boolean;
  blockers: unknown[];
  checks: LiveReadinessCheck[];
  evidence: unknown[];
  forward: unknown[];
  approvable: unknown[];
}

export interface RiskSnapshot {
  killSwitch: { halted: boolean; reason: string; at: number };
  limits: unknown;
  peak: number | null;
  peakResetAt: number | null;
  circuit: string;
  performance: unknown;
}

interface WsState {
  connected: boolean;
  mode?: string;
  symbols?: string[];
  lastAt?: number;
  apiWeight?: number;
  wsStatus?: unknown;
  venue?: unknown;
}

interface DashboardStore {
  // connectivity / status
  health: { ok: boolean; mode: string; dataDir: string; symbols: string[] } | null;
  ws: WsState;
  setWs: (partial: Partial<WsState>) => void;
  setHealth: (h: DashboardStore["health"]) => void;

  // selected symbol
  selectedSymbol: string;
  setSelectedSymbol: (s: string) => void;

  // market state
  symbolsState: Record<string, SymbolState>;
  setSymbolState: (s: string, v: SymbolState) => void;
  marketState: Record<string, unknown> | null;
  setMarketState: (m: Record<string, unknown> | null) => void;

  // account / positions
  account: { equity: number; marginUsed: number; initialEquity: number } | null;
  setAccount: (a: DashboardStore["account"]) => void;
  positions: PositionRow[];
  setPositions: (p: PositionRow[]) => void;

  // risk
  risk: RiskSnapshot | null;
  setRisk: (r: RiskSnapshot) => void;

  // decisions
  decisions: DecisionRow[];
  setDecisions: (d: DecisionRow[]) => void;
  decisionRefusals: { total: number; counts: Record<string, number> } | null;
  setDecisionRefusals: (s: DashboardStore["decisionRefusals"]) => void;

  // research
  research: ResearchSummary | null;
  setResearch: (r: ResearchSummary) => void;

  // live readiness
  liveReadiness: LiveReadinessResult | null;
  setLiveReadiness: (l: LiveReadinessResult) => void;

  // polling control
  lastUpdate: number;
  setLastUpdate: (t: number) => void;
  error: string | null;
  setError: (e: string | null) => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
  health: null,
  ws: { connected: false },
  setWs: (partial) => set((s) => ({ ws: { ...s.ws, ...partial } })),
  setHealth: (h) => set({ health: h }),

  selectedSymbol: "BTCUSDT",
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),

  symbolsState: {},
  setSymbolState: (symbol, v) =>
    set((s) => ({ symbolsState: { ...s.symbolsState, [symbol]: v } })),
  marketState: null,
  setMarketState: (marketState) => set({ marketState }),

  account: null,
  setAccount: (account) => set({ account }),
  positions: [],
  setPositions: (positions) => set({ positions }),

  risk: null,
  setRisk: (risk) => set({ risk }),

  decisions: [],
  setDecisions: (decisions) => set({ decisions }),
  decisionRefusals: null,
  setDecisionRefusals: (decisionRefusals) => set({ decisionRefusals }),

  research: null,
  setResearch: (research) => set({ research }),

  liveReadiness: null,
  setLiveReadiness: (liveReadiness) => set({ liveReadiness }),

  lastUpdate: 0,
  setLastUpdate: (lastUpdate) => set({ lastUpdate }),
  error: null,
  setError: (error) => set({ error }),
}));
