import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { BinanceService } from '../binance/client.js';
import type { Candle, Signal } from '../types.js';
import { resampleCandles } from '../market/TimeframeEngine.js';

export interface EmaCrossConfig {
  targetPct?: number;
  stopAtrMult?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  atrPeriod?: number;
  symbols?: string[];
}

function calculateEma(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calculateAtr(candles: Candle[], period = 14): number[] {
  const atr = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return atr;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    trSum += tr;
  }
  atr[period] = trSum / period;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}

export class EmaCrossSwingAgent extends BaseAgent {
  readonly id = 'EMA-SWING-ν' as const;
  readonly strategy = 'ema_cross_swing_4h';
  override readonly cooldownMs = 0;
  private readonly targetPct: number;
  private readonly stopAtrMult: number;
  private readonly fastPeriod: number;
  private readonly slowPeriod: number;
  private readonly atrPeriod: number;
  private readonly targetSymbols: Set<string>;
  private lastHandledTime = new Map<string, number>();

  constructor(binance: BinanceService, config: EmaCrossConfig = {}) {
    super(binance);
    this.targetPct = config.targetPct ?? 8.0;
    this.stopAtrMult = config.stopAtrMult ?? 1.0;
    this.fastPeriod = config.fastPeriod ?? 20;
    this.slowPeriod = config.slowPeriod ?? 50;
    this.atrPeriod = config.atrPeriod ?? 14;
    this.targetSymbols = new Set(config.symbols ?? ['SOLUSDT', 'BTCUSDT']);
  }

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const symbol of Object.keys(ctx.candles)) {
      if (this.targetSymbols.size > 0 && !this.targetSymbols.has(symbol)) continue;
      const sig = this.analyzeSymbol(symbol, ctx);
      if (sig) signals.push(sig);
    }
    return signals;
  }

  private analyzeSymbol(symbol: string, ctx: MarketContext): Signal | null {
    const raw = ctx.candles[symbol];
    if (!raw || raw.length < 100) return null;

    // Resample to 4H and exclude forming candle to eliminate repainting risk
    const bars4h = resampleCandles(raw, '4h').slice(0, -1);
    const lastBar = bars4h.at(-1);
    if (!lastBar || this.lastHandledTime.get(symbol) === lastBar.openTime) return null;
    if (bars4h.length < this.slowPeriod + 5) return null;

    const closes = bars4h.map(b => b.close);
    const fastEma = calculateEma(closes, this.fastPeriod);
    const slowEma = calculateEma(closes, this.slowPeriod);
    const atr = calculateAtr(bars4h, this.atrPeriod);
    const i = closes.length - 1;

    if (isNaN(fastEma[i]) || isNaN(slowEma[i]) || isNaN(fastEma[i - 1]) || isNaN(slowEma[i - 1]) || isNaN(atr[i])) {
      return null;
    }

    const isBullCross = fastEma[i - 1] <= slowEma[i - 1] && fastEma[i] > slowEma[i];
    const isBearCross = fastEma[i - 1] >= slowEma[i - 1] && fastEma[i] < slowEma[i];
    if (!isBullCross && !isBearCross) return null;

    this.lastHandledTime.set(symbol, lastBar.openTime);
    return this.buildSignal(symbol, isBullCross, ctx.marks[symbol] || lastBar.close, atr[i]);
  }

  private buildSignal(symbol: string, isLong: boolean, mark: number, atrValue: number): Signal {
    const stopDist = atrValue * this.stopAtrMult;
    const stopLoss = isLong ? mark - stopDist : mark + stopDist;
    const takeProfit = isLong ? mark * (1 + this.targetPct / 100) : mark * (1 - this.targetPct / 100);
    const dirStr = isLong ? 'BULL' : 'BEAR';

    return this.signal({
      symbol,
      type: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: 0.85,
      entry: mark,
      stopLoss,
      takeProfit,
      reason: `EMA ${this.fastPeriod}/${this.slowPeriod} 4H ${dirStr} cross (target +${this.targetPct}%, stop ${this.stopAtrMult}x ATR)`,
    });
  }
}
