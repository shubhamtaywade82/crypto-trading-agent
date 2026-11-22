import type { Candle } from '../types.js';
import { detectLiquidity } from './LiquidityEngine.js';
import { findStructureBreakEvents } from './StructureEventLog.js';
import { detectCauseZone } from './ZoneEngine.js';
import { buildZoneLedger } from './ZoneLedger.js';
import type {
  PriceZone,
  RangePricing,
  SmcStructureContext,
  StructureBreak,
  StructureState,
  SwingPoint,
  Timeframe,
  TrendDirection,
  ZoneRecord,
} from './types.js';

function isSwingHigh(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.high;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price <= candles[index - i].high || price <= candles[index + i].high) return false;
  }
  return true;
}

function isSwingLow(candles: Candle[], index: number, strength: number): boolean {
  const price = candles[index]?.low;
  if (price === undefined) return false;
  for (let i = 1; i <= strength; i++) {
    if (price >= candles[index - i].low || price >= candles[index + i].low) return false;
  }
  return true;
}

export function findSwingPoints(candles: Candle[], strength = 2): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const candle = candles[i];
    if (isSwingHigh(candles, i, strength)) highs.push({ index: i, time: candle.openTime, price: candle.high, type: 'HIGH' });
    if (isSwingLow(candles, i, strength)) lows.push({ index: i, time: candle.openTime, price: candle.low, type: 'LOW' });
  }

  return { highs, lows };
}

function inferStructureTrend(highs: SwingPoint[], lows: SwingPoint[]): TrendDirection {
  if (highs.length < 2 || lows.length < 2) return 'NEUTRAL';

  const [prevHigh, lastHigh] = highs.slice(-2);
  const [prevLow, lastLow] = lows.slice(-2);

  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) return 'BULLISH';
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) return 'BEARISH';
  return 'NEUTRAL';
}

export interface StructureOptions {
  strength?: number;
  bufferPct?: number;
}

interface BreakContext {
  trend: TrendDirection;
  highs: SwingPoint[];
  lows: SwingPoint[];
  atrValue: number;
  bufferPct?: number;
}

function makeBreak(
  candle: Candle,
  level: number,
  direction: 'BULLISH' | 'BEARISH',
  meta: { type: 'BOS' | 'CHOCH'; atrValue: number; index: number },
): StructureBreak {
  return {
    type: meta.type,
    direction,
    level,
    index: meta.index,
    time: candle.openTime,
    distanceAtr: Math.abs(candle.close - level) / meta.atrValue,
  };
}

function findLatestBreak(candles: Candle[], ctx: BreakContext): StructureBreak | null {
  if (candles.length < 2 || ctx.atrValue <= 0) return null;
  const buffer = ctx.atrValue * (ctx.bufferPct ?? 0);
  const current = candles.at(-1)!;
  const prev = candles.at(-2)!;
  const lastHigh = ctx.highs.filter((p) => p.index < candles.length - 1).at(-1);
  const lastLow = ctx.lows.filter((p) => p.index < candles.length - 1).at(-1);
  const idx = candles.length - 1;

  if (lastHigh && prev.close <= lastHigh.price && current.close > lastHigh.price + buffer) {
    const type = ctx.trend === 'BEARISH' ? 'CHOCH' : 'BOS';
    return makeBreak(current, lastHigh.price, 'BULLISH', { type, atrValue: ctx.atrValue, index: idx });
  }
  if (lastLow && prev.close >= lastLow.price && current.close < lastLow.price - buffer) {
    const type = ctx.trend === 'BULLISH' ? 'CHOCH' : 'BOS';
    return makeBreak(current, lastLow.price, 'BEARISH', { type, atrValue: ctx.atrValue, index: idx });
  }
  return null;
}

export function analyzeStructure(
  timeframe: Timeframe,
  candles: Candle[],
  atrValue: number,
  options?: number | StructureOptions,
): StructureState {
  const strength = typeof options === 'number' ? options : (options?.strength ?? 2);
  const bufferPct = typeof options === 'object' ? (options?.bufferPct ?? 0) : 0;
  const { highs, lows } = findSwingPoints(candles, strength);
  const trend = inferStructureTrend(highs, lows);

  const protectedHigh =
    trend === 'BEARISH' ? highs.at(-1) ?? null : highs.slice(-2, -1)[0] ?? highs.at(-1) ?? null;
  const protectedLow =
    trend === 'BULLISH' ? lows.at(-1) ?? null : lows.slice(-2, -1)[0] ?? lows.at(-1) ?? null;

  const breaks = findStructureBreakEvents(candles, atrValue, strength, { bufferPct });

  return {
    timeframe,
    trend,
    swingHighs: highs.slice(-20),
    swingLows: lows.slice(-20),
    lastBreak: findLatestBreak(candles, { trend, highs, lows, atrValue, bufferPct }),
    protectedHigh,
    protectedLow,
    breaks,
  };
}

export function calculateRangePricing(candles: Candle[], window = 50): RangePricing {
  const sample = candles.slice(-window);
  const high = sample.length ? Math.max(...sample.map((c) => c.high)) : 0;
  const low = sample.length ? Math.min(...sample.map((c) => c.low)) : 0;
  const equilibrium = high > low ? (high + low) / 2 : high;
  const last = sample.at(-1)?.close ?? 0;
  const positionPct = high > low ? ((last - low) / (high - low)) * 100 : 50;
  return {
    high,
    low,
    equilibrium,
    positionPct,
    premium: positionPct > 50,
    discount: positionPct < 50,
  };
}

export function evaluateStructureState(
  timeframe: Timeframe,
  candles: Candle[],
  atrValue: number,
  options?: number | StructureOptions,
): SmcStructureContext {
  const structure = analyzeStructure(timeframe, candles, atrValue, options);
  const liquidity = detectLiquidity(timeframe, candles, structure, atrValue);
  const pricing = calculateRangePricing(candles);
  const zones = detectCauseZone(timeframe, candles, structure.lastBreak, atrValue);
  const zoneLedger = buildZoneLedger(timeframe, candles, atrValue, structure.breaks ?? []);

  return {
    timeframe,
    structure,
    zones,
    zoneLedger,
    pricing,
    liquidity,
  };
}
