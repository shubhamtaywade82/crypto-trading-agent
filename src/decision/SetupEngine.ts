import type { MarketState, LiquidityPool, LiquiditySweep, PriceZone, VolatilityRegime, TrendDirection } from '../market/types.js';

export type SetupDirection = 'LONG' | 'SHORT';
export type SetupKind = 'BREAKOUT_RETEST' | 'PULLBACK_RETEST' | 'LIQUIDITY_SWEEP';
export type SetupState = 'WATCHING' | 'TRIGGERED' | 'NO_TRADE';

export interface ExpectedMoveWindow {
  minMinutes: number;
  maxMinutes: number;
  thesisExpiryMinutes: number;
  distanceAtr: number;
}

export interface SetupScenario {
  id: string;
  kind: SetupKind;
  direction: SetupDirection;
  state: Exclude<SetupState, 'NO_TRADE'>;
  timeframe: '15m' | '1h' | '4h';
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2?: number;
  trigger: string;
  invalidation: string;
  flowHypothesis: string;
  expectedMove: ExpectedMoveWindow;
  sourceTime: number;
  rewardRisk: number;
}

export interface SetupMap {
  symbol: string;
  generatedAt: number;
  mark: number;
  state: SetupState;
  bias: TrendDirection;
  regime: string;
  volatility: VolatilityRegime;
  positionPct: number;
  location: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  htfTrend: TrendDirection;
  ltfTrend: TrendDirection;
  lastBreak: { type: 'BOS' | 'CHOCH'; direction: TrendDirection; level: number; time: number; distanceAtr: number } | null;
  nearestUpperLiquidity: number | null;
  nearestLowerLiquidity: number | null;
  crowding: string | null;
  openInterestExpansion: boolean | null;
  takerAggressionRatio: number | null;
  scenarios: SetupScenario[];
  noTradeReasons: string[];
}

const TF_MINUTES: Readonly<Record<SetupScenario['timeframe'], number>> = { '15m': 15, '1h': 60, '4h': 240 };
const VOL_PACE_ATR_PER_BAR: Readonly<Record<VolatilityRegime, number>> = { LOW: 0.35, MEDIUM: 0.55, HIGH: 0.85 };
const MAX_SWEEP_AGE_MS = 6 * 15 * 60_000;
const STOP_BUFFER_ATR = 0.15;
const MAX_STOP_ATR = 4;
const MIN_STOP_ATR = 0.5;

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);

const roundMinutes = (minutes: number): number => Math.max(5, Math.round(minutes / 5) * 5);

function expectedMove(
  distance: number,
  atrValue: number,
  timeframe: SetupScenario['timeframe'],
  volatility: VolatilityRegime,
): ExpectedMoveWindow | null {
  if (!(atrValue > 0) || !(distance > 0)) return null;
  const distanceAtr = distance / atrValue;
  const pace = VOL_PACE_ATR_PER_BAR[volatility];
  const bars = Math.min(24, Math.max(1.5, distanceAtr / pace));
  const tfMinutes = TF_MINUTES[timeframe];
  const minMinutes = roundMinutes(bars * tfMinutes * 0.5);
  const maxMinutes = roundMinutes(bars * tfMinutes * 2);
  return {
    minMinutes,
    maxMinutes: Math.max(maxMinutes, minMinutes),
    thesisExpiryMinutes: Math.max(roundMinutes(maxMinutes * 1.5), tfMinutes * 4),
    distanceAtr,
  };
}

function locationOf(state: MarketState): SetupMap['location'] {
  if (state.pricing.premium) return 'PREMIUM';
  if (state.pricing.discount) return 'DISCOUNT';
  return 'EQUILIBRIUM';
}

function trendOf(state: MarketState): TrendDirection {
  if (state.regime.trendDirection !== 'NEUTRAL') return state.regime.trendDirection;
  return state.htfStructure.trend !== 'NEUTRAL' ? state.htfStructure.trend : state.ltfStructure.trend;
}

function isDirectionalLiquidity(pool: LiquidityPool, direction: SetupDirection): boolean {
  const highSide = pool.type === 'EQUAL_HIGH' || pool.type === 'SWING_HIGH' || pool.type === 'RANGE_HIGH';
  const lowSide = pool.type === 'EQUAL_LOW' || pool.type === 'SWING_LOW' || pool.type === 'RANGE_LOW';
  return direction === 'LONG' ? highSide : lowSide;
}

function directionalPool(state: MarketState, direction: SetupDirection, entry: number): LiquidityPool | null {
  const pools = [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => isDirectionalLiquidity(pool, direction))
    .filter((pool) => direction === 'LONG' ? pool.price > entry : pool.price < entry)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  return pools[0] ?? null;
}

function secondDirectionalPool(state: MarketState, direction: SetupDirection, after: number): LiquidityPool | null {
  const pools = [...state.liquidity.ltf.pools, ...state.liquidity.htf.pools]
    .filter((pool) => isDirectionalLiquidity(pool, direction))
    .filter((pool) => direction === 'LONG' ? pool.price > after : pool.price < after)
    .sort((a, b) => Math.abs(a.price - after) - Math.abs(b.price - after));
  return pools[0] ?? null;
}

function freshZone(state: MarketState, direction: SetupDirection, mark: number): PriceZone | null {
  const type: PriceZone['type'] = direction === 'LONG' ? 'DEMAND' : 'SUPPLY';
  const zones = state.zones
    .filter((zone) => zone.type === type && zone.fresh)
    .filter((zone) => direction === 'LONG' ? zone.low <= mark : zone.high >= mark)
    .sort((a, b) => Math.abs(mark - (a.low + a.high) / 2) - Math.abs(mark - (b.low + b.high) / 2));
  return zones[0] ?? null;
}

function stopForZone(
  direction: SetupDirection,
  zone: PriceZone,
  atrValue: number,
): number {
  return direction === 'LONG'
    ? zone.low - atrValue * STOP_BUFFER_ATR
    : zone.high + atrValue * STOP_BUFFER_ATR;
}

function riskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  return risk > 0 ? Math.abs(target - entry) / risk : 0;
}

function flowHypothesis(
  state: MarketState,
  direction: SetupDirection,
  trigger: SetupKind,
): string {
  const crowd = state.crowding?.positioningExtreme;
  const oi = state.crowding?.openInterestExpansion;
  const ratio = state.crowding?.takerAggressionRatio;
  if (trigger === 'LIQUIDITY_SWEEP') {
    return direction === 'LONG'
      ? 'sell-side sweep; absorption/reversal hypothesis'
      : 'buy-side sweep; distribution/reversal hypothesis';
  }
  if (oi && finite(ratio)) {
    if (direction === 'LONG' && ratio > 1.1) return 'initiative buy-flow hypothesis with OI expansion';
    if (direction === 'SHORT' && ratio < 0.9) return 'initiative sell-flow hypothesis with OI expansion';
  }
  if (crowd === 'SHORT_CROWDED' && direction === 'LONG') return 'short-crowding; squeeze/continuation hypothesis';
  if (crowd === 'LONG_CROWDED' && direction === 'SHORT') return 'long-crowding; liquidation/continuation hypothesis';
  return 'trend continuation hypothesis; flow not independently confirmed';
}

function stateForBreakout(mark: number, level: number, direction: SetupDirection): SetupScenario['state'] {
  const triggered = direction === 'LONG' ? mark >= level : mark <= level;
  return triggered ? 'TRIGGERED' : 'WATCHING';
}

function stateForZone(state: MarketState, zone: PriceZone, direction: SetupDirection): SetupScenario['state'] {
  const touched = direction === 'LONG' ? state.mark >= zone.low && state.mark <= zone.high * 1.002 : state.mark <= zone.high && state.mark >= zone.low * 0.998;
  const breakEvent = state.ltfStructure.lastBreak;
  const confirmed = breakEvent !== null
    && breakEvent.time >= zone.originTime
    && ((direction === 'LONG' && breakEvent.direction === 'BULLISH') || (direction === 'SHORT' && breakEvent.direction === 'BEARISH'));
  return touched && confirmed ? 'TRIGGERED' : 'WATCHING';
}

function stateForSweep(state: MarketState, sweep: LiquiditySweep, direction: SetupDirection): SetupScenario['state'] {
  const reclaimed = direction === 'LONG' ? state.mark > sweep.level : state.mark < sweep.level;
  const breakEvent = state.ltfStructure.lastBreak;
  const confirmed = breakEvent !== null
    && breakEvent.time >= sweep.time
    && ((direction === 'LONG' && breakEvent.direction === 'BULLISH') || (direction === 'SHORT' && breakEvent.direction === 'BEARISH'));
  return reclaimed && confirmed ? 'TRIGGERED' : 'WATCHING';
}

function buildBreakout(
  state: MarketState,
  direction: SetupDirection,
  atrValue: number,
): SetupScenario | null {
  const pool = directionalPool(state, direction, state.mark);
  if (!pool) return null;

  const level = pool.price;
  const next = secondDirectionalPool(state, direction, level);
  if (!next) return null;

  const pad = atrValue * 0.20;
  const entryLow = direction === 'LONG' ? level : level - pad;
  const entryHigh = direction === 'LONG' ? level + pad : level;
  const entry = direction === 'LONG' ? entryHigh : entryLow;
  const stop = direction === 'LONG' ? level - atrValue * 0.35 : level + atrValue * 0.35;
  const target1 = next.price;
  const rr = riskReward(entry, stop, target1);
  const move = expectedMove(Math.abs(target1 - entry), atrValue, '15m', state.regime.volatility);
  if (!move || rr < 1.25 || Math.abs(entry - stop) / atrValue > MAX_STOP_ATR) return null;

  return {
    id: 'breakout-' + state.symbol + '-' + direction + '-' + Math.round(level * 100),
    kind: 'BREAKOUT_RETEST',
    direction,
    state: stateForBreakout(state.mark, level, direction),
    timeframe: '15m',
    entryLow,
    entryHigh,
    stopLoss: stop,
    target1,
    target2: undefined,
    trigger: (direction === 'LONG' ? '15m close above ' : '15m close below ') + level.toFixed(4) + ' + retest hold',
    invalidation: direction === 'LONG' ? 'acceptance back below breakout level' : 'acceptance back above breakout level',
    flowHypothesis: flowHypothesis(state, direction, 'BREAKOUT_RETEST'),
    expectedMove: move,
    sourceTime: state.generatedAt,
    rewardRisk: rr,
  };
}

function buildPullback(
  state: MarketState,
  direction: SetupDirection,
  atrValue: number,
): SetupScenario | null {
  const zone = freshZone(state, direction, state.mark);
  if (!zone) return null;
  const entry = direction === 'LONG' ? Math.min(state.mark, zone.high) : Math.max(state.mark, zone.low);
  const stop = stopForZone(direction, zone, atrValue);
  const target = directionalPool(state, direction, Math.max(entry, state.mark));
  if (!target) return null;
  const second = secondDirectionalPool(state, direction, target.price);
  const riskAtr = Math.abs(entry - stop) / atrValue;
  const rr = riskReward(entry, stop, target.price);
  const move = expectedMove(Math.abs(target.price - entry), atrValue, '15m', state.regime.volatility);
  if (!move || riskAtr < MIN_STOP_ATR || riskAtr > MAX_STOP_ATR || rr < 1.25) return null;

  return {
    id: 'pullback-' + state.symbol + '-' + direction + '-' + zone.originTime,
    kind: 'PULLBACK_RETEST',
    direction,
    state: stateForZone(state, zone, direction),
    timeframe: '15m',
    entryLow: zone.low,
    entryHigh: zone.high,
    stopLoss: stop,
    target1: target.price,
    target2: second?.price,
    trigger: direction === 'LONG'
      ? '15m rejection of fresh demand + bullish BOS/CHOCH'
      : '15m rejection of fresh supply + bearish BOS/CHOCH',
    invalidation: direction === 'LONG' ? '15m acceptance below demand' : '15m acceptance above supply',
    flowHypothesis: flowHypothesis(state, direction, 'PULLBACK_RETEST'),
    expectedMove: move,
    sourceTime: zone.originTime,
    rewardRisk: rr,
  };
}

function latestSweep(state: MarketState, direction: SetupDirection): LiquiditySweep | null {
  const wanted: LiquiditySweep['direction'] = direction === 'LONG' ? 'SELL_SIDE' : 'BUY_SIDE';
  return [...state.liquidity.ltf.recentSweeps]
    .filter((sweep) => sweep.confirmed && sweep.direction === wanted)
    .sort((a, b) => b.time - a.time)[0] ?? null;
}

function buildSweep(
  state: MarketState,
  direction: SetupDirection,
  atrValue: number,
): SetupScenario | null {
  const sweep = latestSweep(state, direction);
  if (!sweep || state.generatedAt - sweep.time > MAX_SWEEP_AGE_MS) return null;
  const target = directionalPool(state, direction, state.mark);
  if (!target || Math.abs(target.price - sweep.level) <= atrValue * 0.5) return null;

  const entry = sweep.level;
  const stop = direction === 'LONG'
    ? sweep.sweepPrice - atrValue * STOP_BUFFER_ATR
    : sweep.sweepPrice + atrValue * STOP_BUFFER_ATR;
  const rr = riskReward(entry, stop, target.price);
  const move = expectedMove(Math.abs(target.price - entry), atrValue, '15m', state.regime.volatility);
  const riskAtr = Math.abs(entry - stop) / atrValue;
  if (!move || riskAtr < MIN_STOP_ATR || riskAtr > MAX_STOP_ATR || rr < 1.25) return null;

  return {
    id: 'sweep-' + state.symbol + '-' + direction + '-' + sweep.time,
    kind: 'LIQUIDITY_SWEEP',
    direction,
    state: stateForSweep(state, sweep, direction),
    timeframe: '15m',
    entryLow: direction === 'LONG' ? entry : entry - atrValue * 0.1,
    entryHigh: direction === 'LONG' ? entry + atrValue * 0.1 : entry,
    stopLoss: stop,
    target1: target.price,
    target2: secondDirectionalPool(state, direction, target.price)?.price,
    trigger: direction === 'LONG'
      ? 'sell-side sweep + reclaim of sweep level + bullish displacement'
      : 'buy-side sweep + reclaim of sweep level + bearish displacement',
    invalidation: direction === 'LONG' ? 'loss of swept low' : 'loss of swept high',
    flowHypothesis: flowHypothesis(state, direction, 'LIQUIDITY_SWEEP'),
    expectedMove: move,
    sourceTime: sweep.time,
    rewardRisk: rr,
  };
}

export function buildSetupMap(state: MarketState): SetupMap {
  const bias = trendOf(state);
  const direction: SetupDirection | null = bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : null;
  const atr15 = state.timeframes['15m'].atr14 ?? 0;
  const scenarios: SetupScenario[] = [];

  if (direction && atr15 > 0) {
    for (const builder of [buildSweep, buildPullback, buildBreakout]) {
      const setup = builder(state, direction, atr15);
      if (setup) scenarios.push(setup);
    }
  }

  const triggered = scenarios.some((scenario) => scenario.state === 'TRIGGERED');
  scenarios.sort((a, b) =>
    Number(b.state === 'TRIGGERED') - Number(a.state === 'TRIGGERED')
    || (b.rewardRisk - a.rewardRisk)
  );
  const noTradeReasons: string[] = [];
  if (!direction) noTradeReasons.push('directional structure is unresolved');
  if (direction && scenarios.length === 0) noTradeReasons.push('no admissible structure/liquidity setup with a valid target');
  if (state.pricing.premium && direction === 'LONG') noTradeReasons.push('long setup is in premium; require stronger confirmation');
  if (state.pricing.discount && direction === 'SHORT') noTradeReasons.push('short setup is in discount; require stronger confirmation');

  return {
    symbol: state.symbol,
    generatedAt: state.generatedAt,
    mark: state.mark,
    state: scenarios.length === 0 ? 'NO_TRADE' : triggered ? 'TRIGGERED' : 'WATCHING',
    bias,
    regime: state.regime.regime,
    volatility: state.regime.volatility,
    positionPct: state.pricing.positionPct,
    location: locationOf(state),
    htfTrend: state.htfStructure.trend,
    ltfTrend: state.ltfStructure.trend,
    lastBreak: state.ltfStructure.lastBreak
      ? {
        type: state.ltfStructure.lastBreak.type,
        direction: state.ltfStructure.lastBreak.direction,
        level: state.ltfStructure.lastBreak.level,
        time: state.ltfStructure.lastBreak.time,
        distanceAtr: state.ltfStructure.lastBreak.distanceAtr,
      }
      : null,
    nearestUpperLiquidity: directionalPool(state, 'LONG', state.mark)?.price ?? null,
    nearestLowerLiquidity: directionalPool(state, 'SHORT', state.mark)?.price ?? null,
    crowding: state.crowding?.positioningExtreme ?? null,
    openInterestExpansion: state.crowding?.openInterestExpansion ?? null,
    takerAggressionRatio: state.crowding?.takerAggressionRatio ?? null,
    scenarios,
    noTradeReasons: noTradeReasons.slice(0, 3),
  };
}

export function formatDuration(window: ExpectedMoveWindow): string {
  const fmt = (minutes: number): string => {
    if (minutes < 60) return minutes + 'm';
    const hours = minutes / 60;
    if (hours < 24) return (Math.round(hours * 10) / 10) + 'h';
    return (Math.round((hours / 24) * 10) / 10) + 'd';
  };
  return fmt(window.minMinutes) + '–' + fmt(window.maxMinutes);
}
