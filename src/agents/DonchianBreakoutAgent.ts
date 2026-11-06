import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { BinanceService } from '../binance/client.js';
import type { Candle, Signal } from '../types.js';
import { resampleCandles } from '../market/TimeframeEngine.js';

export interface DonchianConfig {
  targetPct?: number;
  stopAtrMult?: number;
  period?: number;
  volMultiplier?: number;
  symbols?: string[];
  timeframe?: '1h' | '4h';
}

function calculateDonchianHighLow(candles: Candle[], period: number) {
  const highs = new Array<number>(candles.length).fill(-Infinity);
  const lows = new Array<number>(candles.length).fill(Infinity);
  for (let i = period - 1; i < candles.length; i++) {
    let maxH = -Infinity, minL = Infinity;
    for (let k = i - period + 1; k <= i; k++) {
      if (candles[k].high > maxH) maxH = candles[k].high;
      if (candles[k].low < minL) minL = candles[k].low;
    }
    highs[i] = maxH;
    lows[i] = minL;
  }
  return { highs, lows };
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

export class DonchianBreakoutAgent extends BaseAgent {
  readonly id = 'DONCHIAN-SURGE-ο' as const;
  readonly strategy = 'donchian_volume_surge';
  override readonly cooldownMs = 0;
  private readonly targetPct: number;
  private readonly stopAtrMult: number;
  private readonly period: number;
  private readonly volMultiplier: number;
  private readonly timeframe: '1h' | '4h';
  private readonly targetSymbols: Set<string>;
  private lastHandledTime = new Map<string, number>();

  constructor(binance: BinanceService, config: DonchianConfig = {}) {
    super(binance);
    this.targetPct = config.targetPct ?? 5.0;
    this.stopAtrMult = config.stopAtrMult ?? 1.0;
    this.period = config.period ?? 20;
    this.volMultiplier = config.volMultiplier ?? 1.4;
    this.timeframe = config.timeframe ?? '1h';
    this.targetSymbols = new Set(config.symbols ?? ['XRPUSDT', 'SOLUSDT']);
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
    if (!raw || raw.length < 50) return null;

    // Resample to target timeframe and drop forming candle to eliminate repainting
    const bars = resampleCandles(raw, this.timeframe).slice(0, -1);
    const lastBar = bars.at(-1);
    if (!lastBar || this.lastHandledTime.get(symbol) === lastBar.openTime) return null;
    if (bars.length < this.period + 5) return null;

    const { highs, lows } = calculateDonchianHighLow(bars, this.period);
    const atr = calculateAtr(bars, 14);
    const i = bars.length - 1;

    let vSum = 0;
    for (let k = i - this.period + 1; k <= i; k++) vSum += bars[k].volume;
    const volSma = vSum / this.period;
    const hasVolSurge = lastBar.volume > volSma * this.volMultiplier;

    // Breakout past prior bar's Donchian channel
    const isBull = lastBar.close > highs[i - 1] && hasVolSurge;
    const isBear = lastBar.close < lows[i - 1] && hasVolSurge;
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
      confidence: 0.80,
      entry: mark,
      stopLoss,
      takeProfit,
      reason: `Donchian ${this.period} ${this.timeframe} ${dirStr} breakout with volume surge (target +${this.targetPct}%, stop ${this.stopAtrMult}x ATR)`,
    });
  }
}
