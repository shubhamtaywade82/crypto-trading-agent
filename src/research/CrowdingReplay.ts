import { crowdingFade } from '../agents/CrowdingAgent.js';
import type { FundingPoint, MetricsPoint } from '../backtesting/archiveDerivatives.js';
import { calculateCrowding } from '../market/CrowdingEngine.js';
import { MarketStateBuilder } from '../market/MarketStateBuilder.js';
import type { DerivativesSnapshot } from '../market/MarketDataTypes.js';
import type { Candle } from '../types.js';
import type { HourContext } from './CandidateSignals.js';
import { HOUR_MS, type Signal } from './SignalBacktest.js';

/**
 * E2 replay: rebuilds, at every closed 15m bar, the MarketState the live CrowdingAgent would have seen, from archive data
 * only, and asks the agent's own decision function. Known differences from live, by construction:
 * - funding is the last *settled* rate (live reads the predicted next rate from premiumIndex);
 * - the taker ratio is the last closed hour's taker buy / sell volume from 1m klines (live: 1h period endpoint);
 * - account and position ratios are the 5m archive snapshot usable at the bar close (live: latest 1h period point).
 */
const WINDOW = 300; // MARKET_DATA_KLINE_LIMIT default
const METRICS_LAG_MS = 5 * 60_000;
const QUARTER_MS = 15 * 60_000;
const MAX_HOLD_MS = 48 * HOUR_MS; // the agent defines no time exit; same cap as the other G4 candidates

export interface CrowdingData {
  bars15: readonly Candle[];
  bars1h: readonly Candle[];
  bars4h: readonly Candle[];
  /** Taker buy and total base volume per 1h bar open time. */
  takerByHour: ReadonlyMap<number, { buy: number; total: number }>;
  metrics: readonly MetricsPoint[];
  funding: readonly FundingPoint[];
  /** Last 1m mark close before `time`. */
  markBefore: (time: number) => number;
}

function lastAtOrBefore<T extends { time: number }>(points: readonly T[], time: number): T | undefined {
  let lo = 0;
  let hi = points.length - 1;
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.time <= time) { found = points[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function derivativesAt(data: CrowdingData, closeTime: number): DerivativesSnapshot | null {
  const m = lastAtOrBefore(data.metrics, closeTime - METRICS_LAG_MS);
  if (!m || closeTime - METRICS_LAG_MS - m.time > HOUR_MS) return null;
  const taker = data.takerByHour.get(Math.floor(closeTime / HOUR_MS) * HOUR_MS - HOUR_MS);
  const sell = taker ? taker.total - taker.buy : 0;
  return {
    asOf: m.time, openInterest: m.openInterest, openInterestChangePct: null,
    globalLongShortRatio: m.globalAccountRatio, topTraderAccountLongShortRatio: m.topTraderAccountRatio,
    topTraderPositionLongShortRatio: m.topTraderPositionRatio,
    takerBuySellRatio: taker && sell > 0 ? taker.buy / sell : null,
    takerVolumeImbalance: null, orderBookImbalance: null, spreadBps: null, basisPct: null,
  };
}

/** Closed bars of `bars` whose close is at or before `time`, at most WINDOW of them. */
function closedWindow(bars: readonly Candle[], intervalMs: number, time: number): Candle[] {
  const first = bars[0]?.openTime ?? 0;
  const end = Math.floor((time - first) / intervalMs); // count of bars closed by `time`
  return bars.slice(Math.max(0, end - WINDOW), Math.max(0, end));
}

/** Signal factory over 15m bar indices; size and gating follow the same §1 regime rule as the other candidates. */
export function crowdingSignalAt(data: CrowdingData, ctx: HourContext, minimumRewardRisk: number): (k: number) => Signal | null {
  const builder = new MarketStateBuilder();
  const symbol = 'REPLAY';
  return (k) => {
    const closeTime = data.bars15[k]!.openTime + QUARTER_MS;
    const hour = Math.floor((closeTime - ctx.hourStart) / HOUR_MS) - 1;
    const regime = ctx.regimes[hour];
    if (hour < 0 || regime === undefined || regime === 'STRESS_CRASH') return null;
    const derivatives = derivativesAt(data, closeTime);
    const fundingRate = lastAtOrBefore(data.funding, closeTime)?.rate ?? 0;
    if (calculateCrowding(derivatives, fundingRate).positioningExtreme === 'BALANCED') return null; // cheap pre-check
    const tf15 = closedWindow(data.bars15, QUARTER_MS, closeTime);
    if (tf15.length < WINDOW) return null;
    const state = builder.build({
      symbol, candles: tf15, mark: data.markBefore(closeTime), fundingRate, derivatives,
      candlesByTimeframe: { '15m': tf15, '1h': closedWindow(data.bars1h, HOUR_MS, closeTime), '4h': closedWindow(data.bars4h, 4 * HOUR_MS, closeTime) },
    });
    const fade = crowdingFade(state, minimumRewardRisk);
    if (!fade) return null;
    const side = fade.side === 'LONG' ? 1 : -1;
    return {
      side, hour, label: `E2:minRR=${minimumRewardRisk}`, stopDistance: Math.abs(fade.entry - fade.stopLoss), stopPrice: fade.stopLoss,
      target: fade.takeProfit, entryTime: closeTime, maxHoldMs: MAX_HOLD_MS, sizeMultiplier: regime === 'HIGH_VOL_EXPANSION' ? 0.5 : 1,
    };
  };
}
