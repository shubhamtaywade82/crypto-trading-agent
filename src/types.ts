export type Side = 'LONG' | 'SHORT';
export type Mode = 'paper' | 'live';
export type AgentId = 'FUNDING-ARB-α' | 'PAIRS-TRD-β' | 'MOMENTUM-γ' | 'RISK-MGR-δ' | 'EXECUTOR-ε' | 'ADAPTIVE-ST-ζ';
export type SignalType = 'OPEN_LONG' | 'OPEN_SHORT' | 'OPEN_HEDGE' | 'CLOSE' | 'MONITOR' | 'ALERT';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  id: string;
  agent: AgentId;
  symbol: string;
  type: SignalType;
  confidence: number;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  notionalUsdt?: number;
  reason: string;
  ts: number;
}

export interface RiskDecision {
  approved: boolean;
  positionSizeUsdt: number;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSS';
  liqBufferAtr: number;
  reason: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  strategy: AgentId;
  entry: number;
  qty: number;
  mark: number;
  upnl: number;
  upnlPct: number;
  leverage: number;
  marginType: 'ISOLATED' | 'CROSS';
  liqDistancePct: number | null;
  serverSl: string;
  serverTp: string;
  initialRisk?: number; // |entry - first SL| in price units; the 1R used for breakeven trailing
  posType?: string; // e.g. 'PERP-SHORT' | 'LONG/SHORT' | 'LONG'
}

/** What the LLM sees when asked to veto an entry; all numbers come from deterministic code. */
export interface VetoSnapshot {
  symbol: string;
  side: Side;
  regime: 'HIGH' | 'MEDIUM' | 'LOW';
  distanceFromLineAtr: number;
  rsi: number;
  fundingRate: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export interface LogEntry {
  ts: number;
  agent: AgentId | 'SYSTEM' | 'MANUAL';
  msg: string;
  level: 'info' | 'success' | 'warn' | 'error';
}

export interface AgentState {
  id: AgentId;
  status: 'RUNNING' | 'PAUSED' | 'WATCHING';
  strategy: string;
  positions: number;
  winRate: number;
  pnl: number;
  progress: number;
}

export interface MarketPriceInfo {
  price: number;
  changePct: number;
  high24h?: number;
  low24h?: number;
  volumeQuote?: number;
  sparkline?: string;
}

export interface StrategyMetrics {
  fundingEthRate?: number;
  fundingEthApr?: number;
  fundingSolRate?: number;
  fundingSolApr?: number;
  nextFundingCountdown?: string;
  zscoreBtcEth?: number;
  zscoreSolAvax?: number;
  btcAtr?: number;
  avaxAtr?: number;
}

export interface AppState {
  mode: Mode;
  equity: number;
  upnl: number;
  marginUsed: number;
  positions: Position[];
  agents: AgentState[];
  logs: LogEntry[];
  funding: Record<string, number>;
  serverTime: number;
  spotPrices?: Record<string, MarketPriceInfo>;
  strategyMetrics?: StrategyMetrics;
  todayDecisions?: number;
  todayExecuted?: number;
  todayMonitored?: number;
  successRate?: number;
  totalPnl?: number;
  sharpe?: number;
  maxDd?: number;
  liqEvents?: number;
  apiWeight?: number;
  var95?: number;
  exposurePct?: number;
  liqBufferAtr?: number;
  corrBtcEth?: number;
}

