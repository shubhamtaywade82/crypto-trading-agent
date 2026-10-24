import { BaseAgent, type MarketContext } from './BaseAgent.js';
import type { BinanceService } from '../binance/client.js';
import type { Candle, Signal } from '../types.js';
import { resampleCandles } from '../market/TimeframeEngine.js';

interface AlmaConfig {
  length: number;
  offset: number;
  sigma: number;
}

function computeAlmaWeights(config: AlmaConfig): number[] {
  const { length, offset, sigma } = config;
  const m = offset * (length - 1);
  const s = length / sigma;
  const weights = new Array<number>(length);
  let weightSum = 0;

  for (let i = 0; i < length; i++) {
    // Shifts Gaussian distribution peak toward recent bars without lagging
    const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
    weights[i] = w;
    weightSum += w;
  }
  return weights.map((w) => w / weightSum);
}

function calculateAlma(prices: number[], config: AlmaConfig): number[] {
  const { length } = config;
  const result = new Array<number>(prices.length).fill(NaN);
  if (prices.length < length) return result;

  const weights = computeAlmaWeights(config);
  for (let i = length - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = 0; j < length; j++) {
      sum += prices[i - length + 1 + j] * weights[j];
    }
    result[i] = sum;
  }
  return result;
}

function calculateWilderAtr(candles: Candle[], period = 14): number[] {
  const atr = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return atr;

  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  atr[period] = sum / period;

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

const FAST_ALMA: AlmaConfig = { length: 21, offset: 0.70, sigma: 8.0 };
const SLOW_ALMA: AlmaConfig = { length: 50, offset: 0.70, sigma: 8.0 };
const HTF_FAST: AlmaConfig = { length: 21, offset: 0.85, sigma: 6.0 };
const HTF_SLOW: AlmaConfig = { length: 50, offset: 0.85, sigma: 6.0 };
const ATR_STOP_MULTIPLIER = 2.5;
const RISK_REWARD_RATIO = 1.5;

export class AlmaMtfChampionAgent extends BaseAgent {
  readonly id = 'ALMA-CHAMPION-λ' as const;
  readonly strategy = 'alma_mtf_champion';
  override readonly cooldownMs = 0;
  private lastHandledTime = new Map<string, number>();

  constructor(binance: BinanceService) {
    super(binance);
  }

  protected async analyze(ctx: MarketContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    const symbols = Object.keys(ctx.candles);
    for (const symbol of symbols) {
      const signal = this.analyzeSymbol(symbol, ctx);
      if (signal) signals.push(signal);
    }
    return signals;
  }

  private getClosedSeries(candles: Candle[], tf: '1h' | '4h'): Candle[] {
    const resampled = resampleCandles(candles, tf);
    // Exclude currently forming candle to prevent repainting signals
    return resampled.slice(0, -1);
  }

  private checkHtfTrend(candles4h: Candle[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (candles4h.length < HTF_SLOW.length + 2) return 'NEUTRAL';
    const closes = candles4h.map((c) => c.close);
    const fast = calculateAlma(closes, HTF_FAST);
    const slow = calculateAlma(closes, HTF_SLOW);
    const i = closes.length - 1;

    if (isNaN(fast[i]) || isNaN(slow[i]) || isNaN(slow[i - 1])) return 'NEUTRAL';
    if (fast[i] > slow[i] && slow[i] >= slow[i - 1]) return 'BULLISH';
    if (fast[i] < slow[i] && slow[i] <= slow[i - 1]) return 'BEARISH';
    return 'NEUTRAL';
  }

  private buildEntrySignal(
    symbol: string,
    isLong: boolean,
    mark: number,
    stopDist: number
  ): Signal {
    const stopLoss = isLong ? mark - stopDist : mark + stopDist;
    const takeProfit = isLong ? mark + stopDist * RISK_REWARD_RATIO : mark - stopDist * RISK_REWARD_RATIO;
    return this.signal({
      symbol,
      type: isLong ? 'OPEN_LONG' : 'OPEN_SHORT',
      confidence: 0.85,
      entry: mark,
      stopLoss,
      takeProfit,
      reason: `ALMA MTF Champion ${isLong ? 'BULL' : 'BEAR'} crossover with confirmed 4H trend (stop dist ${stopDist.toFixed(2)})`,
    });
  }

  private analyzeSymbol(symbol: string, ctx: MarketContext): Signal | null {
    const rawCandles = ctx.candles[symbol];
    if (!rawCandles || rawCandles.length < 100) return null;

    const bars1h = this.getClosedSeries(rawCandles, '1h');
    const lastBar = bars1h.at(-1);
    if (!lastBar || this.lastHandledTime.get(symbol) === lastBar.openTime) return null;

    const bars4h = this.getClosedSeries(rawCandles, '4h');
    const htfRegime = this.checkHtfTrend(bars4h);
    if (htfRegime === 'NEUTRAL') return null;

    const closes1h = bars1h.map((c) => c.close);
    const fast1h = calculateAlma(closes1h, FAST_ALMA);
    const slow1h = calculateAlma(closes1h, SLOW_ALMA);
    const atr1h = calculateWilderAtr(bars1h, 14);

    const i = closes1h.length - 1;
    if (isNaN(fast1h[i]) || isNaN(slow1h[i]) || isNaN(fast1h[i - 1]) || isNaN(slow1h[i - 1])) return null;

    const isBullCross = fast1h[i - 1] <= slow1h[i - 1] && fast1h[i] > slow1h[i];
    const isBearCross = fast1h[i - 1] >= slow1h[i - 1] && fast1h[i] < slow1h[i];

    if ((isBullCross && htfRegime === 'BULLISH') || (isBearCross && htfRegime === 'BEARISH')) {
      const mark = ctx.marks[symbol] || lastBar.close;
      const stopDist = atr1h[i] * ATR_STOP_MULTIPLIER;
      this.lastHandledTime.set(symbol, lastBar.openTime);
      return this.buildEntrySignal(symbol, isBullCross, mark, stopDist);
    }

    return null;
  }
}
