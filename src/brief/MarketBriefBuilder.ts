import type { MinuteRecord } from '../marketdata/MinuteAggregator.js';
import type {
  BriefDecision,
  BriefMarketData,
  BriefOiTrend,
  BriefPositioning,
  BriefScenario,
  BriefSnapshotComparison,
  BriefTimeframe,
  BriefTimeframeRead,
  BriefZone,
  Dominance,
  MarketBrief,
  TrendRead,
} from './types.js';
import { BRIEF_TIMEFRAMES, TIMEFRAME_MS } from './types.js';
import type { Candle } from '../types.js';
import { fmtPrice, utcDateKey } from './format.js';

/**
 * Pure analysis over BriefMarketData: no I/O, no clock reads beyond the passed timestamp, no
 * random or fitted parameters. Every rule below is deterministic so a brief can be reproduced
 * from its inputs, and every conclusion is stated with the evidence that produced it.
 */
export interface BriefBuildOptions {
  /** Fractal swing strength: a swing needs this many confirmed candles on each side. */
  swingLookback: number;
  /** Levels within this percent of price cluster into one zone. */
  zoneTolerancePct: number;
  /** Global long/short account ratio at which positioning is called long-crowded. */
  longCrowdRatio: number;
  /** Recorded per-minute history for the snapshot-comparison section, oldest first. */
  history?: MinuteRecord[];
  /** Recorded days to compare against (YYYY-MM-DD). Default: the two most recent recorded days. */
  compareDates?: string[];
  /** Clock used to decide which recorded day counts as "today". Defaults to the fetchedAt stamp. */
  now?: number;
}

export const DEFAULT_BRIEF_BUILD_OPTIONS: BriefBuildOptions = {
  swingLookback: 2,
  zoneTolerancePct: 0.15,
  longCrowdRatio: 2,
};

const trendWord = (trend: TrendRead): string =>
  trend === 'UP' ? 'bullish' : trend === 'DOWN' ? 'bearish' : trend === 'FLAT' ? 'mixed' : 'unresolved';

/** Trend of confirmed closes only. Needs the last close to agree with both the prior close and the close three bars back. */
function computeTrend(candles: Candle[]): TrendRead {
  if (candles.length < 4) return candles.length > 0 ? 'FLAT' : 'UNKNOWN';
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1]!;
  const prev = closes[closes.length - 2]!;
  const back = closes[closes.length - 4]!;
  if (last > prev && last > back) return 'UP';
  if (last < prev && last < back) return 'DOWN';
  return 'FLAT';
}

function combineTrends(a: TrendRead, b: TrendRead): TrendRead {
  if (a === b) return a;
  if (a === 'UNKNOWN') return b;
  if (b === 'UNKNOWN') return a;
  return 'FLAT';
}

function buildTimeframeRead(timeframe: BriefTimeframe, data: BriefMarketData): BriefTimeframeRead {
  const klines = data.candles[timeframe];
  const confirmed = klines?.confirmed ?? [];
  const last = confirmed[confirmed.length - 1] ?? null;
  const forming = klines?.forming ?? null;
  const trend = computeTrend(confirmed);

  const relation: BriefTimeframeRead['formingVsConfirmedClose'] =
    !forming || !last ? 'UNKNOWN'
      : forming.last > last.close ? 'ABOVE'
      : forming.last < last.close ? 'BELOW'
      : 'AT';

  const closes = confirmed.map((c) => c.close);
  const back = closes.length >= 4 ? closes[closes.length - 4]! : closes[0] ?? null;

  let confirmedNarrative: string;
  if (!last || back === null) {
    confirmedNarrative = 'Not enough confirmed candles to read a structure.';
  } else if (trend === 'UP') {
    confirmedNarrative = `Confirmed closes are advancing: ${fmtPrice(back)} -> ${fmtPrice(last.close)}; the last confirmed candle traded ${fmtPrice(last.low)}-${fmtPrice(last.high)} and closed at ${fmtPrice(last.close)}.`;
  } else if (trend === 'DOWN') {
    confirmedNarrative = `Confirmed closes are weakening: ${fmtPrice(back)} -> ${fmtPrice(last.close)}; the last confirmed candle traded ${fmtPrice(last.low)}-${fmtPrice(last.high)} and closed at ${fmtPrice(last.close)}.`;
  } else {
    confirmedNarrative = `Confirmed closes are mixed around ${fmtPrice(last.close)}; the last confirmed candle traded ${fmtPrice(last.low)}-${fmtPrice(last.high)}.`;
  }

  let formingNarrative: string;
  if (!forming) {
    formingNarrative = 'No candle is currently open on this timeframe.';
  } else if (relation === 'BELOW') {
    formingNarrative = `The current candle is forming around ${fmtPrice(forming.last)}, below its ${fmtPrice(forming.open)} open and below the last confirmed close, with a low of ${fmtPrice(forming.low)} so far.`;
  } else if (relation === 'ABOVE') {
    formingNarrative = `The current candle is forming around ${fmtPrice(forming.last)}, above its ${fmtPrice(forming.open)} open and above the last confirmed close, with a high of ${fmtPrice(forming.high)} so far.`;
  } else {
    formingNarrative = `The current candle is forming around ${fmtPrice(forming.last)}, near the last confirmed close of ${fmtPrice(last?.close ?? forming.last)}.`;
  }

  return {
    timeframe,
    intervalMs: TIMEFRAME_MS[timeframe],
    confirmed: last,
    confirmedCloseTime: last ? last.openTime + TIMEFRAME_MS[timeframe] : null,
    forming,
    trend,
    formingVsConfirmedClose: relation,
    confirmedNarrative,
    formingNarrative,
  };
}

interface SwingLevel {
  price: number;
  time: number;
  timeframe: BriefTimeframe;
  kind: 'LOW' | 'HIGH';
}

/**
 * Fractal swings on confirmed candles only. A swing low at i needs the k candles on each side to
 * hold higher lows; the last k confirmed candles can never be swings because their right side is
 * still unknown — the same confirmed-candle discipline the structure table applies.
 */
function findSwings(candles: Candle[], k: number, timeframe: BriefTimeframe, kind: 'LOW' | 'HIGH'): SwingLevel[] {
  const out: SwingLevel[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const value = kind === 'LOW' ? candles[i]!.low : candles[i]!.high;
    let isSwing = true;
    for (let j = i - k; j <= i + k && isSwing; j++) {
      if (j === i) continue;
      const other = kind === 'LOW' ? candles[j]!.low : candles[j]!.high;
      if (kind === 'LOW' ? other < value : other > value) isSwing = false;
    }
    if (isSwing) out.push({ price: value, time: candles[i]!.openTime, timeframe, kind });
  }
  return out;
}

interface ZoneCluster extends BriefZone {
  sources: SwingLevel[];
}

/** Groups sorted levels into zones whenever neighbours sit within tolerancePct of the reference price. */
function clusterLevels(levels: SwingLevel[], tolerancePct: number, refPrice: number): ZoneCluster[] {
  const tolerance = (refPrice * tolerancePct) / 100;
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters: ZoneCluster[] = [];

  for (const level of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && level.price - current.high <= tolerance) {
      current.high = Math.max(current.high, level.price);
      current.low = Math.min(current.low, level.price);
      current.sources.push(level);
    } else {
      clusters.push({ role: 'LOWER_SUPPORT', low: level.price, high: level.price, why: '', sources: [level] });
    }
  }

  for (const cluster of clusters) {
    const byTf = new Map<string, number>();
    for (const s of cluster.sources) byTf.set(s.timeframe, (byTf.get(s.timeframe) ?? 0) + 1);
    const summary = [...byTf.entries()].map(([tf, n]) => `${tf}${n > 1 ? ` x${n}` : ''}`).join(', ');
    cluster.why = `${cluster.sources[0]!.kind === 'LOW' ? 'swing lows' : 'swing highs'} from ${summary}`;
  }

  return clusters;
}

/** Roles: nearest support below price, the reclaim zone just above it, and the rungs beyond each. */
function assignZoneRoles(supports: ZoneCluster[], resistances: ZoneCluster[]): BriefZone[] {
  const out: BriefZone[] = [];

  supports
    .sort((a, b) => b.high - a.high)
    .forEach((zone, i) => {
      out.push({ ...zone, role: i === 0 ? 'IMMEDIATE_SUPPORT' : i === 1 ? 'NEXT_SUPPORT' : 'LOWER_SUPPORT' });
    });

  resistances
    .sort((a, b) => a.low - b.low)
    .forEach((zone, i) => {
      out.push({ ...zone, role: i === 0 ? 'RECLAIM_ZONE' : i === 1 ? 'NEAR_TERM_RESISTANCE' : 'HIGHER_RESISTANCE' });
    });

  return out;
}

/**
 * How many confirmed candles each timeframe contributes to the zone map. Long histories bury the
 * map under levels from weeks ago; these windows keep it on structure the operator can still trade.
 */
const ZONE_LOOKBACK: Record<'15m' | '1h' | '4h', number> = { '15m': 96, '1h': 72, '4h': 42 };
/** Levels further than this from the last price are outside the brief's operating range. */
const ZONE_RELEVANCE_PCT = 8;

function buildZones(data: BriefMarketData, price: number, options: BriefBuildOptions): BriefZone[] {
  const lows: SwingLevel[] = [];
  const highs: SwingLevel[] = [];

  // 5m swings are noise at this scale; zones are built from 15m/1h/4h structure.
  for (const tf of ['15m', '1h', '4h'] as const) {
    const candles = (data.candles[tf]?.confirmed ?? []).slice(-ZONE_LOOKBACK[tf]);
    lows.push(...findSwings(candles, options.swingLookback, tf, 'LOW'));
    highs.push(...findSwings(candles, options.swingLookback, tf, 'HIGH'));
  }

  const high24h = data.ticker?.high24h ?? null;
  const low24h = data.ticker?.low24h ?? null;
  if (high24h !== null) highs.push({ price: high24h, time: data.fetchedAt, timeframe: '1h', kind: 'HIGH' });

  const relevance = (level: number) => Math.abs(level - price) / price <= ZONE_RELEVANCE_PCT / 100;
  const relevant = (levels: SwingLevel[]) => levels.filter((l) => relevance(l.price));

  // A cluster that straddles the price stays on its natural side: a swing-high band containing
  // price is resistance until a close clears its top, and a swing-low band containing price is
  // support until a close loses its bottom.
  const supports = clusterLevels(relevant(lows), options.zoneTolerancePct, price).filter((z) => z.low <= price);
  const resistances = clusterLevels(relevant(highs), options.zoneTolerancePct, price).filter((z) => z.high >= price);

  const zones = assignZoneRoles(supports, resistances);

  // The 24h low is the day's structural floor and is reported on its own row, like the day high
  // inside the resistance clustering: it is a reference, not a mapped support level.
  if (low24h !== null && low24h < price) {
    zones.push({ role: 'MAJOR_REFERENCE', low: low24h, high: low24h, why: 'current 24-hour low' });
  }

  // Brief order: supports nearest-first, then resistances nearest-first. The stable sort keeps
  // the proximity order assignZoneRoles already established inside each role group.
  const roleOrder: Record<BriefZone['role'], number> = {
    IMMEDIATE_SUPPORT: 0, NEXT_SUPPORT: 1, LOWER_SUPPORT: 2, MAJOR_REFERENCE: 3,
    RECLAIM_ZONE: 4, NEAR_TERM_RESISTANCE: 5, HIGHER_RESISTANCE: 6,
  };
  return zones.sort((a, b) => roleOrder[a.role] - roleOrder[b.role]);
}

function buildPositioning(data: BriefMarketData, price: number | null): BriefPositioning {
  const oiTrend: BriefOiTrend = { from: null, to: null, fromTime: null, toTime: null, changePct: null };
  if (data.oiHistory.length > 0) {
    const first = data.oiHistory[0]!;
    const last = data.oiHistory[data.oiHistory.length - 1]!;
    oiTrend.from = first.sumOpenInterest;
    oiTrend.to = last.sumOpenInterest;
    oiTrend.fromTime = first.timestamp;
    oiTrend.toTime = last.timestamp;
    oiTrend.changePct = first.sumOpenInterest > 0
      ? ((last.sumOpenInterest - first.sumOpenInterest) / first.sumOpenInterest) * 100
      : null;
  }

  const fundingRate = data.mark?.fundingRate ?? null;

  return {
    fundingRate,
    nextFundingTime: data.mark?.nextFundingTime ?? null,
    fundingAprPct: fundingRate !== null ? fundingRate * 3 * 365 * 100 : null,
    openInterest: data.openInterest,
    openInterestNotionalUsd: data.openInterest !== null && price !== null ? data.openInterest * price : null,
    oiTrend,
    globalLongShortRatio: data.globalRatio?.ratio ?? null,
    globalLongPct: data.globalRatio?.longPct ?? null,
    globalShortPct: data.globalRatio?.shortPct ?? null,
    topTraderPositionLongShortRatio: data.topTraderPositionRatio,
    taker: data.taker,
  };
}

function dominanceWord(d: Dominance): string {
  return d === 'SELL' ? 'sell-dominant' : d === 'BUY' ? 'buy-dominant' : d === 'BALANCED' ? 'balanced' : 'unreported';
}

function zoneWord(role: BriefZone['role']): string {
  switch (role) {
    case 'IMMEDIATE_SUPPORT': return 'immediate support';
    case 'NEXT_SUPPORT': return 'next support';
    case 'LOWER_SUPPORT': return 'lower support';
    case 'MAJOR_REFERENCE': return 'major reference';
    case 'RECLAIM_ZONE': return 'reclaim zone';
    case 'NEAR_TERM_RESISTANCE': return 'near-term resistance';
    case 'HIGHER_RESISTANCE': return 'higher resistance';
  }
}

function buildScenarios(zones: BriefZone[], taker: BriefPositioning['taker']): { bullish: BriefScenario; bearish: BriefScenario } {
  const immediateSupport = zones.find((z) => z.role === 'IMMEDIATE_SUPPORT') ?? null;
  const reclaim = zones.find((z) => z.role === 'RECLAIM_ZONE') ?? null;
  const beyondResistance = zones.filter((z) => z.role === 'NEAR_TERM_RESISTANCE' || z.role === 'HIGHER_RESISTANCE');
  const belowSupport = zones.filter((z) => z.role === 'NEXT_SUPPORT' || z.role === 'LOWER_SUPPORT' || z.role === 'MAJOR_REFERENCE');
  const flowWord = dominanceWord(taker['5m'].dominance);

  const zoneRef = (z: BriefZone) => `${fmtPrice(z.low)}${z.high !== z.low ? `–${fmtPrice(z.high)}` : ''}`;

  const bullish: BriefScenario = {
    direction: 'BULLISH',
    confirmationLevel: reclaim?.high ?? null,
    steps: reclaim
      ? [
          `Price reclaims the ${zoneRef(reclaim)} ${zoneWord(reclaim.role)}.`,
          `A confirmed 15m close above ${fmtPrice(reclaim.high)} is followed by a successful hold or retest of the zone.`,
          `Taker buying strengthens rather than remaining ${flowWord} on the short intervals.`,
          beyondResistance.length > 0
            ? `The market then tests ${zoneRef(beyondResistance[0]!)}.`
            : `The market then extends above the reclaim zone; no mapped resistance sits beyond it.`,
        ]
      : ['No mapped resistance sits above the last price, so there is no reclaim zone to confirm.'],
    invalidation: reclaim
      ? `Failure to hold the reclaimed zone, followed by renewed selling toward ${fmtPrice(immediateSupport?.low ?? reclaim.low)}.`
      : 'A renewed decline without an established reclaim zone invalidates the recovery read.',
    nextReferences: beyondResistance,
  };

  const bearish: BriefScenario = {
    direction: 'BEARISH',
    confirmationLevel: immediateSupport?.low ?? null,
    steps: immediateSupport
      ? [
          `A confirmed 15m close below ${fmtPrice(immediateSupport.low)} establishes more than an intrabar dip.`,
          `Price fails to reclaim ${fmtPrice(immediateSupport.low)} on the following candles.`,
          `Taker selling remains dominant rather than turning ${dominanceWord(taker['1h'].dominance)} like the latest hourly bucket.`,
        ]
      : ['No mapped support sits below the last price, so there is no breakdown level to confirm.'],
    invalidation: immediateSupport
      ? `An immediate reclaim and hold back above ${fmtPrice(immediateSupport.low)} cancels the breakdown.`
      : 'A sustained advance without a breakdown level invalidates the bearish read.',
    nextReferences: belowSupport,
  };

  return { bullish, bearish };
}

/** Day-over-day comparison against the recorded per-minute history. Point-in-time snapshots, not period returns. */
export function buildSnapshotComparisons(
  history: MinuteRecord[],
  price: number | null,
  openInterest: number | null,
  compareDates?: string[],
  now: number = Date.now(),
): BriefSnapshotComparison[] {
  // History is oldest-first with one record per minute; the last write per day is that day's closing snapshot.
  const byDay = new Map<string, MinuteRecord>();
  for (const record of history) byDay.set(utcDateKey(record.t), record);

  const today = utcDateKey(now);
  let days: string[];
  if (compareDates && compareDates.length > 0) {
    days = compareDates;
  } else {
    days = [...byDay.keys()].filter((d) => d !== today).sort().slice(-2);
  }

  return days.flatMap((date) => {
    const record = byDay.get(date);
    if (!record) return [];
    const recordedMark = record.mark ?? record.index ?? null;
    return [{
      date,
      recordedAt: record.t,
      recordedMark,
      currentVsRecordedPct: recordedMark !== null && recordedMark !== 0 && price !== null
        ? ((price - recordedMark) / recordedMark) * 100
        : null,
      recordedOpenInterest: record.openInterest,
      oiChangePct: record.openInterest !== null && record.openInterest !== 0 && openInterest !== null
        ? ((openInterest - record.openInterest) / record.openInterest) * 100
        : null,
      recordedFunding: record.funding,
      recordedTakerRatio: record.takerRatio,
    }];
  });
}

interface DecisionInput {
  price: number | null;
  high24h: number | null;
  timeframes: Record<BriefTimeframe, BriefTimeframeRead>;
  positioning: BriefPositioning;
  zones: BriefZone[];
  noEntryZone: { low: number | null; high: number | null };
  dataErrors: string[];
}

function buildDecision(input: DecisionInput): Pick<MarketBrief, 'decision' | 'decisionHeadline' | 'summary' | 'noTradeReasons'> {
  const { price, timeframes, positioning, zones, noEntryZone, dataErrors } = input;
  const reasons: string[] = [];

  const htf = combineTrends(timeframes['1h']!.trend, timeframes['4h']!.trend);
  const ltf = combineTrends(timeframes['5m']!.trend, timeframes['15m']!.trend);
  const immediateSupport = zones.find((z) => z.role === 'IMMEDIATE_SUPPORT') ?? null;
  const reclaim = zones.find((z) => z.role === 'RECLAIM_ZONE') ?? null;
  const confirmed15m = timeframes['15m']!.confirmed?.close ?? null;

  const taker5m = positioning.taker['5m'];
  const taker15m = positioning.taker['15m'];
  const sellFlow = taker5m.dominance === 'SELL' && taker15m.dominance === 'SELL';
  const conflict = (htf === 'UP' && ltf === 'DOWN') || (htf === 'DOWN' && ltf === 'UP');
  const longCrowded = positioning.globalLongShortRatio !== null && positioning.globalLongShortRatio >= 2;
  const oiDeclining = positioning.oiTrend.changePct !== null && positioning.oiTrend.changePct < 0;

  const priceInNoEntry = price !== null
    && noEntryZone.low !== null && noEntryZone.high !== null
    && price >= noEntryZone.low && price <= noEntryZone.high;
  // Confirmation is the CONFIRMED 15m close clearing a mapped level — never the live price, which
  // can wick beyond a level and return within the same forming candle.
  const reclaimConfirmed = reclaim !== null && confirmed15m !== null && confirmed15m > reclaim.high;
  const breakdownConfirmed = immediateSupport !== null && confirmed15m !== null && confirmed15m < immediateSupport.low;

  let decision: BriefDecision;
  if (price === null) {
    decision = 'NO_TRADE';
    reasons.push('no usable price reading is available, so the market data are incomplete or stale');
  } else if (reclaimConfirmed) {
    decision = 'LONG_BIAS';
  } else if (breakdownConfirmed) {
    decision = 'SHORT_BIAS';
  } else {
    decision = 'NO_TRADE';
  }

  if (decision === 'NO_TRADE') {
    if (price !== null && noEntryZone.low !== null && noEntryZone.high !== null) {
      if (priceInNoEntry) {
        reasons.push(`price is inside the no-entry zone between support (${fmtPrice(noEntryZone.low)}) and the reclaim zone (${fmtPrice(noEntryZone.high)}) without a confirmed breakout or breakdown`);
      }
      if (price < noEntryZone.low && confirmed15m !== null && confirmed15m >= noEntryZone.low) {
        reasons.push(`price has dipped below ${fmtPrice(noEntryZone.low)} on a still-forming candle, which is not confirmation`);
      }
      if (price > noEntryZone.high && confirmed15m !== null && confirmed15m <= noEntryZone.high) {
        reasons.push(`price is above ${fmtPrice(noEntryZone.high)} but the confirming 15m candle has not closed there yet`);
      }
    } else if (price !== null) {
      reasons.push('the support/resistance map is incomplete, so no confirmation level exists');
    }

    if (conflict) {
      reasons.push(`the ${trendWord(htf)} 1h/4h structure conflicts with the ${trendWord(ltf)} 5m/15m pressure`);
    }
    if (sellFlow) {
      reasons.push(`short-term taker flow is sell-dominant (5m ${taker5m.ratio?.toFixed(4) ?? '—'}, 15m ${taker15m.ratio?.toFixed(4) ?? '—'})`);
    }
    if (oiDeclining && htf === 'UP') {
      reasons.push(`open interest has declined ${Math.abs(positioning.oiTrend.changePct!).toFixed(2)}% across the reported window, so the recovery is not confirmed by fresh positioning`);
    }
    if (longCrowded) {
      const ratio = positioning.globalLongShortRatio!;
      reasons.push(`positioning is long-crowded at ${ratio.toFixed(2)} long accounts per short (${positioning.globalLongPct?.toFixed(2) ?? '—'}% long), so a decline could pressure longs`);
    }
    if (dataErrors.length > 0) {
      reasons.push(`${dataErrors.length} market-data endpoint(s) failed (${dataErrors.map((e) => e.split(':')[0]).join(', ')}), so part of the evidence is missing`);
    }
  }

  const decisionHeadline =
    decision === 'NO_TRADE' ? 'NO TRADE — wait for confirmation'
    : decision === 'LONG_BIAS' ? `LONG BIAS — reclaim confirmed above ${fmtPrice(reclaim?.high ?? null)}; confirmation steps remain`
    : `SHORT BIAS — breakdown confirmed below ${fmtPrice(immediateSupport?.low ?? null)}; confirmation steps remain`;

  const summary: string[] = [];
  const htfPhrase = `The 1h and 4h structures are ${trendWord(htf)}`;
  const ltfPhrase = ltf === 'DOWN' ? 'the shorter timeframes are pulling back' : ltf === 'UP' ? 'the shorter timeframes are advancing' : 'the shorter timeframes are unresolved';
  const pullbackRef = ltf === 'DOWN' && input.high24h !== null ? ` from the $${fmtPrice(input.high24h)} high` : '';
  summary.push(`${htfPhrase}, but ${ltfPhrase}${pullbackRef}.`);

  const flowPhrase = sellFlow ? 'sell-dominant' : taker5m.dominance === 'BUY' ? 'buy-dominant' : 'mixed';
  const oiPhrase = positioning.oiTrend.changePct === null ? 'unchanged across an unreported window' : oiDeclining ? 'declined' : 'risen';
  const crowdPhrase = positioning.globalLongShortRatio !== null
    ? `global accounts remain heavily net-${longCrowded ? 'long' : 'short'} biased (${positioning.globalLongShortRatio.toFixed(2)}:1)`
    : 'global account positioning is unreported';
  summary.push(`Recent taker flow is ${flowPhrase}, open interest has ${oiPhrase} across the reported window, and ${crowdPhrase}.`);

  if (decision === 'NO_TRADE' && price !== null) {
    summary.push('Price is testing nearby levels without confirming either a bullish recovery or a bearish breakdown. Entering now would mean acting before the conflicting evidence resolves, and no probability is assigned because the available evidence does not establish one.');
  }

  return { decision, decisionHeadline, summary, noTradeReasons: reasons };
}

/**
 * Assembles the full brief. The executive call is conservative by construction: a directional
 * bias requires a CONFIRMED 15m close beyond a mapped zone; everything else — including a break
 * that only a forming candle shows — stays NO_TRADE.
 */
export function buildMarketBrief(
  data: BriefMarketData,
  overrides: Partial<BriefBuildOptions> = {},
): MarketBrief {
  // Partial options merge over defaults so a caller passing only `now` or `history` cannot
  // silently disable swing detection or clustering with undefined thresholds.
  const options: BriefBuildOptions = { ...DEFAULT_BRIEF_BUILD_OPTIONS, ...overrides };
  const price = data.ticker?.lastPrice ?? data.mark?.markPrice ?? data.candles['5m']?.forming?.last ?? data.candles['1h']?.confirmed?.at(-1)?.close ?? null;

  const timeframes = Object.fromEntries(
    BRIEF_TIMEFRAMES.map((tf) => [tf, buildTimeframeRead(tf, data)]),
  ) as Record<BriefTimeframe, BriefTimeframeRead>;

  const zones = price !== null ? buildZones(data, price, options) : [];
  const immediateSupport = zones.find((z) => z.role === 'IMMEDIATE_SUPPORT') ?? null;
  const reclaim = zones.find((z) => z.role === 'RECLAIM_ZONE') ?? null;
  const noEntryZone = { low: immediateSupport?.low ?? null, high: reclaim?.high ?? null };

  const positioning = buildPositioning(data, price);
  const scenarios = buildScenarios(zones, positioning.taker);
  const history = buildSnapshotComparisons(options.history ?? [], price, positioning.openInterest, options.compareDates, options.now ?? data.fetchedAt);

  const decision = buildDecision({ price, high24h: data.ticker?.high24h ?? null, timeframes, positioning, zones, noEntryZone, dataErrors: data.errors });

  const bottomLine = decision.decision === 'NO_TRADE'
    ? `Current call: NO TRADE. Wait for a confirmed reclaim above ${fmtPrice(noEntryZone.high)} or a confirmed breakdown below ${fmtPrice(noEntryZone.low)} — with follow-through — before considering a directional setup.`
    : `Current call: ${decision.decision}. The confirmation steps above are still conditions, not predictions; each must print before any entry is considered.`;

  return {
    symbol: data.symbol,
    generatedAt: data.fetchedAt,
    ...decision,
    dataErrors: data.errors,
    price: {
      lastPrice: price,
      changePct24h: data.ticker?.changePct ?? null,
      changeAbs24h: data.ticker?.changeAbs ?? null,
      high24h: data.ticker?.high24h ?? null,
      low24h: data.ticker?.low24h ?? null,
      volumeBase24h: data.ticker?.volumeBase ?? null,
      volumeQuote24h: data.ticker?.volumeQuote ?? null,
      markPrice: data.mark?.markPrice ?? null,
      indexPrice: data.mark?.indexPrice ?? null,
      bestBid: data.book.bestBid,
      bestAsk: data.book.bestAsk,
    },
    timeframes,
    positioning,
    book: data.book,
    zones,
    noEntryZone,
    scenarios,
    history,
    bottomLine,
  };
}
