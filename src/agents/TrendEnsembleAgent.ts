import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { Candle, Position, Signal } from '../types.js';
import { wilderAtr } from '../binance/indicators.js';
import { roundPrice } from '../binance/symbolRules.js';

// Port of the v13 research survivor (scratchpad/SOLUSDT-MULTIASSET-v13.md): Zarattini et al. (2025) Donchian
// ensemble on 4h bars. XRP failed the v13 walk-forward, so only SOL and ETH are traded.
const SYMBOLS = ['SOLUSDT', 'ETHUSDT'];
const LOOKBACKS_4H = [5, 10, 20, 30, 60, 90].map((days) => days * 6);
const ATR_PERIOD = 14;
const STOP_ATR = 2;
// The v13 exit study found a fixed 2-ATR stop plus the ensemble's own exit beat every trailing rule tested
// (including TrailingStopManager tiers). The far target exists only to satisfy the risk gate's R:R check.
const FAR_TARGET_R = 10;
const ENTRY_CONFIDENCE = 0.8;
export const MIN_BARS_4H = Math.max(...LOOKBACKS_4H) + ATR_PERIOD + 1;

export type Side = -1 | 0 | 1;

/** Ensemble side at the last close: per lookback, enter on a close beyond the prior n-bar close extreme and exit on
 * a close through a stop ratcheted to the n-bar close midpoint; the side is the majority of lookbacks. */
export function ensembleSide(closes: number[], lookbacks: number[] = LOOKBACKS_4H): Side {
  let votes = 0;
  for (const n of lookbacks) votes += lookbackSide(closes, n);
  const half = lookbacks.length / 2;
  return votes >= half ? 1 : votes <= -half ? -1 : 0;
}

function lookbackSide(closes: number[], n: number): Side {
  let side: Side = 0;
  let stop = 0;
  for (let k = n; k < closes.length; k++) {
    const window = closes.slice(k - n, k);
    const hi = Math.max(...window);
    const lo = Math.min(...window);
    const c = closes[k];
    const mid = (Math.max(hi, c) + Math.min(lo, c)) / 2;
    if (side !== 0 && (c - stop) * side < 0) side = 0;
    if (side === 0 && (c > hi || c < lo)) {
      side = c > hi ? 1 : -1;
      stop = mid;
    }
    if (side !== 0) stop = side > 0 ? Math.max(stop, mid) : Math.min(stop, mid);
  }
  return side;
}

export interface ExitStop {
  symbol: string;
  strategy: Position['strategy'];
  stopLoss: number;
  takeProfit: number;
}

/** Enters when the 4h Donchian ensemble changes side; exits when it leaves the position's side. */
export class TrendEnsembleAgent extends BaseAgent {
  readonly id = 'TREND-ENS-μ' as const;
  readonly strategy = 'donchian_ensemble_4h';
  // Entries fire once per side change of a closed 4h bar, so the shared fill cooldown would only drop real flips
  override readonly cooldownMs = 0;
  private sides = new Map<string, Side>();
  private lastHandledOpenTime = new Map<string, number>();

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const symbol of SYMBOLS) {
      const signal = this.analyzeSymbol(symbol, ctx);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  /** Latest ensemble side for a symbol, once enough closed 4h history has loaded. */
  sideFor(symbol: string): Side | undefined {
    return this.sides.get(symbol);
  }

  private analyzeSymbol(symbol: string, ctx: MarketContext): Signal | null {
    // Market-data snapshots hold closed 4h bars only; needs MARKET_DATA_KLINE_LIMIT >= MIN_BARS_4H
    const bars: Candle[] = ctx.marketDataV2?.[symbol]?.candles['4h'] ?? [];
    const last = bars.at(-1);
    const mark = ctx.marks[symbol];
    if (bars.length < MIN_BARS_4H || !last || !mark || this.lastHandledOpenTime.get(symbol) === last.openTime) return null;
    this.lastHandledOpenTime.set(symbol, last.openTime);

    const closes = bars.map((b) => b.close);
    const side = ensembleSide(closes);
    const previous = this.sides.get(symbol) ?? ensembleSide(closes.slice(0, -1));
    this.sides.set(symbol, side);
    if (side === 0 || side === previous) return null;

    const atr = wilderAtr(bars, ATR_PERIOD).at(-1);
    if (!atr || !Number.isFinite(atr)) return null;
    const stopDistance = STOP_ATR * atr;
    return this.signal({
      symbol,
      type: side > 0 ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: ENTRY_CONFIDENCE,
      entry: mark,
      stopLoss: mark - side * stopDistance,
      takeProfit: mark + side * FAR_TARGET_R * stopDistance,
      reason: `4h Donchian ensemble turned ${side > 0 ? 'LONG' : 'SHORT'} (2-ATR stop ${stopDistance.toFixed(4)})`,
    });
  }

  /** Stops moved to the mark for this agent's positions the ensemble no longer supports, so the next tick closes them. */
  exitStops(positions: Position[], marks: Record<string, number>): ExitStop[] {
    const exits: ExitStop[] = [];
    for (const position of positions) {
      if (position.strategy !== this.id) continue;
      const side = this.sides.get(position.symbol);
      const mark = marks[position.symbol];
      const held: Side = position.side === 'LONG' ? 1 : -1;
      if (side === undefined || side === held || !mark) continue;
      exits.push({ symbol: position.symbol, strategy: position.strategy, stopLoss: roundPrice(position.symbol, mark), takeProfit: Number(position.serverTp) });
    }
    return exits;
  }
}
