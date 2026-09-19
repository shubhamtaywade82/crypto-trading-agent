import type { AdaptiveSuperTrendBar } from '../binance/adaptiveSuperTrend.js';
import { atr, ema, pairZScore } from '../binance/indicators.js';
import { correlation, simpleReturns, summarizePerformance, type StrategyPerformance } from '../binance/performance.js';
import type { AdaptiveInfo, AgentId, AgentState, AppState, Candle, FundingInfo, Position, StrategyMetrics, TradeRecord, WsStatus } from '../types.js';

export interface AgentRuntime { id: AgentId; status: 'RUNNING' | 'PAUSED' | 'WATCHING'; strategy: string }
export interface SessionCounters { decisions: number; executed: number; monitored: number }
export interface TelemetryInput {
  account: { equity: number; marginUsed: number; initialEquity: number };
  positions: Position[]; trades: TradeRecord[];
  candles: Record<string, Candle[]>; funding: Record<string, number>; nextFundingTime: number;
  adaptive: Record<string, AdaptiveSuperTrendBar | undefined>;
  agents: AgentRuntime[]; counters: SessionCounters;
  apiWeight: number; wsStatus: WsStatus; now: number;
}
export type Telemetry = Pick<AppState, 'initialEquity' | 'totalPnl' | 'totalPnlPct' | 'successRate' | 'sharpe' | 'maxDd' | 'var95' | 'liqEvents' | 'sessionDecisions' | 'sessionExecuted' | 'sessionMonitored' | 'apiWeight' | 'wsStatus' | 'exposurePct' | 'minLiqDistancePct' | 'corrBtcEth' | 'agents' | 'strategyMetrics'>;

const BTC = 'BTCUSDT';
const ETH = 'ETHUSDT';
const FUNDING_AGENT: AgentId = 'FUNDING-ARB-α';
const FUNDINGS_PER_DAY = 3;
const DAYS_PER_YEAR = 365;
const MIN_PAIR_CANDLES = 30;
const EMA_PERIOD = 50;
const ATR_PERIOD = 14;
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

function exposurePct(positions: Position[], equity: number): number {
  if (equity <= 0) return 0;
  const notional = positions.reduce((sum, p) => sum + p.qty * p.mark, 0);
  return (notional / equity) * 100;
}

function minLiqDistancePct(positions: Position[]): number | null {
  const distances = positions.map((p) => p.liqDistancePct).filter((d): d is number => d !== null);
  return distances.length === 0 ? null : Math.min(...distances);
}

function closesOf(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

function corrBtcEth(candles: Record<string, Candle[]>): number | null {
  if (!candles[BTC] || !candles[ETH]) return null;
  return correlation(simpleReturns(closesOf(candles[BTC])), simpleReturns(closesOf(candles[ETH])));
}

function buildAgents(runtimes: AgentRuntime[], positions: Position[], byStrategy: Record<string, StrategyPerformance>): AgentState[] {
  return runtimes.map((runtime) => {
    const open = positions.filter((p) => p.strategy === runtime.id);
    const stats = byStrategy[runtime.id];
    const unrealized = open.reduce((sum, p) => sum + p.upnl, 0);
    const winRate = stats && stats.closed > 0 ? (stats.wins / stats.closed) * 100 : null;
    return { ...runtime, positions: open.length, winRate, pnl: (stats?.pnl ?? 0) + unrealized };
  });
}

function fundingBySymbol(funding: Record<string, number>): Record<string, FundingInfo> {
  const bySymbol: Record<string, FundingInfo> = {};
  for (const [symbol, rate] of Object.entries(funding)) {
    bySymbol[symbol] = { rate, apr: rate * FUNDINGS_PER_DAY * DAYS_PER_YEAR * 100 };
  }
  return bySymbol;
}

function fundingCountdown(nextFundingTime: number, now: number): string | null {
  if (nextFundingTime <= 0) return null;
  const totalMinutes = Math.floor(Math.max(0, nextFundingTime - now) / MS_PER_MINUTE);
  return `${Math.floor(totalMinutes / MINUTES_PER_HOUR)}h${totalMinutes % MINUTES_PER_HOUR}m`;
}

function estNextFundingUsd(positions: Position[], funding: Record<string, number>): number {
  let total = 0;
  for (const p of positions.filter((pos) => pos.strategy === FUNDING_AGENT)) {
    const payerSign = p.side === 'SHORT' ? 1 : -1; // shorts receive positive funding, longs pay it
    total += payerSign * p.qty * p.mark * (funding[p.symbol] ?? 0);
  }
  return total;
}

function zscoreBtcEth(candles: Record<string, Candle[]>): number | null {
  const [btc, eth] = [candles[BTC], candles[ETH]];
  if (!btc || !eth || btc.length < MIN_PAIR_CANDLES || eth.length < MIN_PAIR_CANDLES) return null;
  return pairZScore(btc, eth);
}

function atrBySymbol(candles: Record<string, Candle[]>): Record<string, number> {
  const bySymbol: Record<string, number> = {};
  for (const [symbol, series] of Object.entries(candles)) bySymbol[symbol] = atr(series, ATR_PERIOD);
  return bySymbol;
}

function adaptiveBySymbol(bars: Record<string, AdaptiveSuperTrendBar | undefined>): Record<string, AdaptiveInfo> {
  const bySymbol: Record<string, AdaptiveInfo> = {};
  for (const [symbol, bar] of Object.entries(bars)) {
    if (!bar) continue;
    const distanceAtr = bar.assignedAtr > 0 ? Math.abs(bar.candle.close - bar.superTrend) / bar.assignedAtr : 0; // zero ATR would yield Infinity in the UI
    bySymbol[symbol] = { direction: bar.direction, regime: bar.regime, superTrend: bar.superTrend, distanceAtr };
  }
  return bySymbol;
}

function momentumAboveEma50(candles: Record<string, Candle[]>): { up: number; total: number } {
  let up = 0;
  let total = 0;
  for (const series of Object.values(candles)) {
    if (series.length < EMA_PERIOD) continue;
    const closes = closesOf(series);
    total += 1;
    if (closes[closes.length - 1] > ema(closes, EMA_PERIOD)[closes.length - 1]) up += 1;
  }
  return { up, total };
}

function buildStrategyMetrics(input: TelemetryInput): StrategyMetrics {
  return {
    fundingBySymbol: fundingBySymbol(input.funding),
    nextFundingCountdown: fundingCountdown(input.nextFundingTime, input.now),
    estNextFundingUsd: estNextFundingUsd(input.positions, input.funding),
    zscoreBtcEth: zscoreBtcEth(input.candles),
    atrBySymbol: atrBySymbol(input.candles),
    adaptive: adaptiveBySymbol(input.adaptive),
    momentumAboveEma50: momentumAboveEma50(input.candles),
  };
}

/** Derives every cockpit figure from real account, journal, candle and funding data; pure, no I/O. */
export function buildTelemetry(input: TelemetryInput): Telemetry {
  const { equity, initialEquity } = input.account;
  const perf = summarizePerformance(input.trades, initialEquity, equity, input.now);
  return {
    initialEquity,
    totalPnl: perf.totalPnl,
    totalPnlPct: perf.totalPnlPct,
    successRate: perf.winRate,
    sharpe: perf.sharpe,
    maxDd: perf.maxDrawdownPct,
    var95: perf.var95,
    liqEvents: perf.liquidations,
    sessionDecisions: input.counters.decisions,
    sessionExecuted: input.counters.executed,
    sessionMonitored: input.counters.monitored,
    apiWeight: input.apiWeight,
    wsStatus: input.wsStatus,
    exposurePct: exposurePct(input.positions, equity),
    minLiqDistancePct: minLiqDistancePct(input.positions),
    corrBtcEth: corrBtcEth(input.candles),
    agents: buildAgents(input.agents, input.positions, perf.byStrategy),
    strategyMetrics: buildStrategyMetrics(input),
  };
}
