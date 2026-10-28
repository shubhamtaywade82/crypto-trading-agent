import type { Candle } from '../types.js';

/**
 * Type model for the live market brief: a one-shot, read-only snapshot of a single USDⓈ-M
 * perpetual structured for a human trading decision (trade / no-trade / wait for confirmation).
 *
 * The brief is deliberately explicit about what is NOT known: every exchange-sourced figure is
 * nullable, forming candles are reported separately from confirmed (closed) candles, and no
 * probability is ever assigned to a scenario. A missing reading renders as "—" and is never
 * invented or substituted from another endpoint.
 */

/** Timeframes the brief reports. Confirmed-candle semantics apply to all of them. */
export type BriefTimeframe = '5m' | '15m' | '1h' | '4h';
export const BRIEF_TIMEFRAMES: readonly BriefTimeframe[] = ['5m', '15m', '1h', '4h'];

/** Taker buy/sell buckets are published per period; the brief reads all three. */
export type TakerPeriod = '5m' | '15m' | '1h';
export const TAKER_PERIODS: readonly TakerPeriod[] = ['5m', '15m', '1h'];

/** Executive call. The brief never claims a probability; LONG_BIAS/SHORT_BIAS still require confirmation steps. */
export type BriefDecision = 'NO_TRADE' | 'LONG_BIAS' | 'SHORT_BIAS';

export type TrendRead = 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
export type Dominance = 'BUY' | 'SELL' | 'BALANCED' | 'UNKNOWN';

export const TIMEFRAME_MS: Record<BriefTimeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/** Section 1 — price and 24-hour statistics. */
export interface BriefPriceStats {
  lastPrice: number | null;
  changePct24h: number | null;
  changeAbs24h: number | null;
  high24h: number | null;
  low24h: number | null;
  /** Base-asset volume (e.g. SOL), not quote. */
  volumeBase24h: number | null;
  volumeQuote24h: number | null;
  markPrice: number | null;
  indexPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}

/**
 * The still-open candle. Every field is a live reading the exchange keeps rewriting; none of it
 * may be treated as a confirmed signal (a break on a forming candle is not a confirmed break).
 */
export interface BriefFormingCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  /** Latest price inside the candle; the forming kline's "close" field. */
  last: number;
}

/** Section 2 — one row of the multi-timeframe structure table. */
export interface BriefTimeframeRead {
  timeframe: BriefTimeframe;
  intervalMs: number;
  confirmed: Candle | null;
  /** Boundary time of the confirmed candle (openTime + intervalMs), i.e. when it closed. */
  confirmedCloseTime: number | null;
  forming: BriefFormingCandle | null;
  /** Trend of the confirmed closes only; forming candles never participate. */
  trend: TrendRead;
  formingVsConfirmedClose: 'ABOVE' | 'BELOW' | 'AT' | 'UNKNOWN';
  /** What the confirmed progression shows, e.g. "recovery intact: closes rose 100.05 -> 101.99". */
  confirmedNarrative: string;
  /** What the forming candle shows right now, e.g. "forming below its 101.99 open". */
  formingNarrative: string;
}

/** Section 3 — one published taker bucket. Timestamps matter: buckets for different periods end at different times. */
export interface BriefTakerBucket {
  period: TakerPeriod;
  ratio: number | null;
  buyVol: number | null;
  sellVol: number | null;
  bucketTime: number | null;
  dominance: Dominance;
}

/** Open-interest trend across the reported hourly statistics snapshots (first -> last of the window). */
export interface BriefOiTrend {
  from: number | null;
  to: number | null;
  fromTime: number | null;
  toTime: number | null;
  changePct: number | null;
}

/** Section 3 — derivatives, positioning and order flow. */
export interface BriefPositioning {
  /** Decimal (0.0001 = 0.01%); longs pay shorts when positive. */
  fundingRate: number | null;
  nextFundingTime: number | null;
  /** Annualised, assuming the default 8h settlement interval. */
  fundingAprPct: number | null;
  openInterest: number | null;
  /** openInterest x last price; an approximation, not an exchange-reported figure. */
  openInterestNotionalUsd: number | null;
  oiTrend: BriefOiTrend;
  globalLongShortRatio: number | null;
  /** Share of accounts on each side, in percent; derived from the ratio when the exchange does not report it. */
  globalLongPct: number | null;
  globalShortPct: number | null;
  topTraderPositionLongShortRatio: number | null;
  taker: Record<TakerPeriod, BriefTakerBucket>;
}

/** Zones are observed price areas derived from recent candles — not guaranteed turning points. */
export type ZoneRole =
  | 'IMMEDIATE_SUPPORT'
  | 'NEXT_SUPPORT'
  | 'LOWER_SUPPORT'
  | 'MAJOR_REFERENCE'
  | 'RECLAIM_ZONE'
  | 'NEAR_TERM_RESISTANCE'
  | 'HIGHER_RESISTANCE';

/** Section 4 — one support/resistance zone. */
export interface BriefZone {
  role: ZoneRole;
  low: number;
  high: number;
  /** Which levels on which timeframes produced the zone. */
  why: string;
}

/** Section 4 — top-of-book facts. Concentrations are transient and can be pulled at any time. */
export interface BriefBook {
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  largestBidLevel: { price: number; qty: number; notional: number } | null;
  largestAskLevel: { price: number; qty: number; notional: number } | null;
}

/** Section 5 — a conditional scenario. Steps are ordered; the first unmet step is where the scenario stands. */
export interface BriefScenario {
  direction: 'BULLISH' | 'BEARISH';
  /** The level a confirmed 15m close must clear (above for bullish, below for bearish). */
  confirmationLevel: number | null;
  steps: string[];
  invalidation: string;
  /** Zones beyond the confirmation level the scenario would put into play. */
  nextReferences: BriefZone[];
}

/** Section 6 — the explicit no-trade band between support and the reclaim zone. */
export interface BriefNoEntryZone {
  low: number | null;
  high: number | null;
}

/** Section 7 — comparison against one previously recorded snapshot day. */
export interface BriefSnapshotComparison {
  /** Recorded day, YYYY-MM-DD. */
  date: string;
  recordedAt: number;
  recordedMark: number | null;
  currentVsRecordedPct: number | null;
  recordedOpenInterest: number | null;
  oiChangePct: number | null;
  recordedFunding: number | null;
  recordedTakerRatio: number | null;
}

/** The assembled brief. Every section is present even when its data is missing. */
export interface MarketBrief {
  symbol: string;
  generatedAt: number;
  decision: BriefDecision;
  decisionHeadline: string;
  /** Executive summary paragraphs, plain sentences. */
  summary: string[];
  /** Human-readable reasons the call is NO_TRADE (empty when it is not). */
  noTradeReasons: string[];
  /** Endpoints that failed or returned nothing; non-empty means the brief is partially blind. */
  dataErrors: string[];
  price: BriefPriceStats;
  timeframes: Record<BriefTimeframe, BriefTimeframeRead>;
  positioning: BriefPositioning;
  book: BriefBook;
  zones: BriefZone[];
  noEntryZone: BriefNoEntryZone;
  scenarios: { bullish: BriefScenario; bearish: BriefScenario };
  history: BriefSnapshotComparison[];
  bottomLine: string;
}

/**
 * Raw per-timeframe kline split. `confirmed` holds only closed candles; `forming`, when present,
 * is the single open candle the exchange keeps updating.
 */
export interface BriefKlines {
  confirmed: Candle[];
  forming: BriefFormingCandle | null;
}

/** Raw collection output consumed by the builder. Fields are null when their endpoint failed. */
export interface BriefMarketData {
  symbol: string;
  fetchedAt: number;
  ticker: {
    lastPrice: number | null;
    changePct: number | null;
    changeAbs: number | null;
    high24h: number | null;
    low24h: number | null;
    volumeBase: number | null;
    volumeQuote: number | null;
  } | null;
  mark: {
    markPrice: number | null;
    indexPrice: number | null;
    fundingRate: number | null;
    nextFundingTime: number | null;
  } | null;
  candles: Partial<Record<BriefTimeframe, BriefKlines>>;
  openInterest: number | null;
  oiHistory: { sumOpenInterest: number; timestamp: number }[];
  globalRatio: { ratio: number | null; longPct: number | null; shortPct: number | null; timestamp: number | null } | null;
  topTraderPositionRatio: number | null;
  taker: Record<TakerPeriod, BriefTakerBucket>;
  book: BriefBook;
  /** Endpoint names that failed; collected so the brief can say which figures are missing and why. */
  errors: string[];
}
