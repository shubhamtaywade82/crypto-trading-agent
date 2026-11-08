import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { BinanceService } from '../binance/client.js';
import type { Candle, Signal } from '../types.js';
import { resampleCandles } from '../market/TimeframeEngine.js';

export interface SqueezeBreakoutConfig {
  targetPct?: number;
  stopAtrMult?: number;
  kcMult?: number;
  symbols?: string[];
}

function calculateSma(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

function calculateStdDev(values: number[], sma: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sumSq = 0;
    for (let k = i - period + 1; k <= i; k++) sumSq += (values[k] - sma[i]) ** 2;
    result[i] = Math.sqrt(sumSq / period);
  }
  return result;
}

function calculateAtr(candles: Candle[], period = 14): number[] {
  const atr = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return atr;
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
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

export class SqueezeBreakoutAgent extends BaseAgent {
  readonly id = 'SQUEEZE-EXP-ξ' as const;
  readonly strategy = 'squeeze_expansion_4h';
  override readonly cooldownMs = 0;
  private readonly targetPct: number;
  private readonly stopAtrMult: number;
  private readonly kcMult: number;
  private readonly targetSymbols: Set<string>;
  private lastHandledTime = new Map<string, number>();

  constructor(binance: BinanceService, config: SqueezeBreakoutConfig = {}) {
    super(binance);
    this.targetPct = config.targetPct ?? 5.0;
    this.stopAtrMult = config.stopAtrMult ?? 0.75;
    this.kcMult = config.kcMult ?? 1.5;
    this.targetSymbols = new Set(config.symbols ?? ['ETHUSDT', 'BTCUSDT']);
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

    // Resample to 4H and drop forming bar to eliminate repainting
    const bars4h = resampleCandles(raw, '4h').slice(0, -1);
    const lastBar = bars4h.at(-1);
    if (!lastBar || this.lastHandledTime.get(symbol) === lastBar.openTime) return null;
    if (bars4h.length < 25) return null;

    const closes = bars4h.map(b => b.close);
    const sma20 = calculateSma(closes, 20);
    const sd20 = calculateStdDev(closes, sma20, 20);
    const atr = calculateAtr(bars4h, 14);
    const volSma20 = calculateSma(bars4h.map(b => b.volume), 20);
    const i = closes.length - 1;

    if (isNaN(sma20[i]) || isNaN(sd20[i]) || isNaN(atr[i]) || isNaN(sd20[i - 1])) return null;

    // TTM Squeeze condition: Bollinger Bands completely within Keltner Channel
    const wasSqueeze = sd20[i - 1] * 2 <= this.kcMult * atr[i - 1];
    const isExpanding = sd20[i] * 2 > this.kcMult * atr[i];
    if (!wasSqueeze || !isExpanding) return null;

    const hasVolSurge = lastBar.volume > volSma20[i] * 1.3;
    const isBull = closes[i] > sma20[i] && hasVolSurge;
    const isBear = closes[i] < sma20[i] && hasVolSurge;
    if (!isBull && !isBear) return null;

    this.lastHandledTime.set(symbol, lastBar.openTime);
    return this.buildSignal(symbol, isBull, ctx.marks[symbol] || lastBar.close, atr[i]);
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
      reason: `TTM Squeeze 4H ${dirStr} expansion with volume confirmation (target +${this.targetPct}%, stop ${this.stopAtrMult}x ATR)`,
    });
  }
}
