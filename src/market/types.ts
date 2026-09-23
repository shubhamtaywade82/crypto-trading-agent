import type { Candle } from '../types.js';

export type Timeframe = '15m' | '1h' | '4h';
export type MarketRegime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'TRANSITION';
export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type VolatilityRegime = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TimeframeState {
  timeframe: Timeframe;
  candleCount: number;
  lastClose: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  emaSlopePct: number | null;
  adx14: number | null;
  atr14: number | null;
  atrPercentile: number | null;
  rsi14: number | null;
  vwap: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
}

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface StructureBreak {
  type: 'BOS' | 'CHOCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  index: number;
  time: number;
  distanceAtr: number;
}

export interface StructureState {
  timeframe: Timeframe;
  trend: TrendDirection;
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  lastBreak: StructureBreak | null;
  protectedHigh: SwingPoint | null;
  protectedLow: SwingPoint | null;
}

export interface LiquidityPool {
  type: 'EQUAL_HIGH' | 'EQUAL_LOW' | 'SWING_HIGH' | 'SWING_LOW' | 'RANGE_HIGH' | 'RANGE_LOW';
  price: number;
  tolerance: number;
  strength: number;
  timeframe: Timeframe;
  sourceTimes: number[];
}

export interface LiquiditySweep {
  poolType: LiquidityPool['type'];
  direction: 'BUY_SIDE' | 'SELL_SIDE';
  level: number;
  sweepPrice: number;
  close: number;
  index: number;
  time: number;
  confirmed: boolean;
}

export interface LiquidityState {
  timeframe: Timeframe;
  pools: LiquidityPool[];
  latestSweeps: LiquiditySweep[];
}

export interface PriceZone {
  type: 'SUPPLY' | 'DEMAND';
  timeframe: Timeframe;
  high: number;
  low: number;
  originTime: number;
  causedBreak: 'BOS' | 'CHOCH' | null;
  displacementAtr: number;
  touches: number;
  fresh: boolean;
  strength: number;
}

export interface RangePricing {
  high: number;
  low: number;
  equilibrium: number;
  positionPct: number;
  premium: boolean;
  discount: boolean;
}

export interface MeanReversionState {
  mean: number | null;
  vwap: number | null;
  zscore: number | null;
  rsi14: number | null;
  bollingerMiddle: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  deviationPct: number | null;
}

export interface RegimeSnapshot {
  regime: MarketRegime;
  trendDirection: TrendDirection;
  trendStrength: number;
  volatility: VolatilityRegime;
  volatilityPercentile: number | null;
  adx14: number | null;
  emaSlopePct: number | null;
}

export interface MarketState {
  version: 1;
  symbol: string;
  generatedAt: number;
  mark: number;
  fundingRate: number;

  regime: RegimeSnapshot;
  timeframes: Record<Timeframe, TimeframeState>;

  htfStructure: StructureState;
  ltfStructure: StructureState;

  liquidity: {
    htf: LiquidityState;
    ltf: LiquidityState;
  };

  zones: PriceZone[];
  pricing: RangePricing;
  meanReversion: MeanReversionState;
}

export interface MarketStateInput {
  symbol: string;
  candles: Candle[];
  mark: number;
  fundingRate: number;
}
