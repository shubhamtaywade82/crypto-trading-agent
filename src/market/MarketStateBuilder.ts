import type { Candle } from '../types.js';
import { detectLiquidity } from './LiquidityEngine.js';
import { classifyRegime, buildTimeframeState } from './RegimeEngine.js';
import { RegimeTracker, type RegimeOptions } from './RegimeScoring.js';
import { calculateCrowding } from './CrowdingEngine.js';
import { calculateMeanReversion } from './MeanReversionEngine.js';
import { analyzeStructure, calculateRangePricing } from './StructureEngine.js';
import { buildZoneLedger } from './ZoneLedger.js';
import { closedCandles, resampleCandles } from './TimeframeEngine.js';
import { detectCauseZone } from './ZoneEngine.js';
import type {
  MarketState,
  MarketStateInput,
  RangePricing,
  Timeframe,
} from './types.js';

const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h'];

function nativeOrResampled(
  native: Partial<Record<'1m' | '5m' | '15m' | '1h' | '4h', Candle[]>> | undefined,
  timeframe: Timeframe,
  fallback15m: Candle[],
): Candle[] {
  const provided = native?.[timeframe];
  if (provided && provided.length > 0) return provided;
  return timeframe === '15m'
    ? fallback15m
    : resampleCandles(fallback15m, timeframe);
}

export class MarketStateBuilder {
  private cache = new Map<string, MarketState>();
  private readonly regimeTracker: RegimeTracker | null;

  /** Pass regime options to use the scored regime with hysteresis; omit for the original first-match classifier. */
  constructor(regimeOptions?: Partial<RegimeOptions>) {
    this.regimeTracker = regimeOptions ? new RegimeTracker(regimeOptions) : null;
  }

  build(input: MarketStateInput): MarketState {
    const fallback15m = closedCandles(input.candles);
    const tf15 = nativeOrResampled(input.candlesByTimeframe, '15m', fallback15m);
    const tf1h = nativeOrResampled(input.candlesByTimeframe, '1h', fallback15m);
    const tf4h = nativeOrResampled(input.candlesByTimeframe, '4h', fallback15m);
    const latestClosedTime = tf15.at(-1)?.openTime ?? 0;
    const cached = this.cache.get(input.symbol);

    if (cached && latestClosedTime === cached.generatedAt) {
      const derivatives = input.derivatives ?? cached.derivatives ?? null;
      return {
        ...cached,
        mark: input.mark,
        fundingRate: input.fundingRate,
        derivatives,
        crowding: calculateCrowding(derivatives, input.fundingRate),
      };
    }

    const timeframes = {
      '15m': buildTimeframeState('15m', tf15),
      '1h': buildTimeframeState('1h', tf1h),
      '4h': buildTimeframeState('4h', tf4h),
    };

    const htfStructure = analyzeStructure('1h', tf1h, timeframes['1h'].atr14 ?? 0);
    const ltfStructure = analyzeStructure('15m', tf15, timeframes['15m'].atr14 ?? 0);

    const liquidity = {
      htf: detectLiquidity('1h', tf1h, htfStructure, timeframes['1h'].atr14 ?? 0),
      ltf: detectLiquidity('15m', tf15, ltfStructure, timeframes['15m'].atr14 ?? 0),
    };

    const zones = [
      ...detectCauseZone('1h', tf1h, htfStructure.lastBreak, timeframes['1h'].atr14 ?? 0),
      ...detectCauseZone('15m', tf15, ltfStructure.lastBreak, timeframes['15m'].atr14 ?? 0),
    ];

    const zoneLedger = [
      ...buildZoneLedger('1h', tf1h, timeframes['1h'].atr14 ?? 0, htfStructure.breaks ?? []),
      ...buildZoneLedger('15m', tf15, timeframes['15m'].atr14 ?? 0, ltfStructure.breaks ?? []),
    ];

    const derivatives = input.derivatives ?? null;
    const regime = this.regimeTracker
      ? this.regimeTracker.update(input.symbol, latestClosedTime, timeframes['15m'], timeframes['1h'])
      : classifyRegime(timeframes['15m'], timeframes['1h']);

    const state: MarketState = {
      version: 1,
      symbol: input.symbol,
      generatedAt: latestClosedTime,
      mark: input.mark,
      fundingRate: input.fundingRate,
      regime,
      timeframes,
      htfStructure,
      ltfStructure,
      liquidity,
      zones,
      zoneLedger,
      pricing: calculateRangePricing(tf1h),
      meanReversion: calculateMeanReversion(tf15, {
        regime,
        adx14: timeframes['15m'].adx14,
      }),
      derivatives,
      crowding: calculateCrowding(derivatives, input.fundingRate),
    };

    this.cache.set(input.symbol, state);
    return state;
  }

  buildAll(inputs: MarketStateInput[]): Record<string, MarketState> {
    return Object.fromEntries(inputs.map((input) => [input.symbol, this.build(input)]));
  }
}
