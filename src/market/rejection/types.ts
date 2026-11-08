/**
 * Types for the liquidity rejection zone engine.
 *
 * The engine works on OHLCV bars that carry taker-buy volume (Binance USD-M kline fields). Every timeframe is derived
 * from canonical 1m bars; a bar is only ever "complete" when every 1m candle inside it is present and valid.
 */

export const REJECTION_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h'] as const;
export type RejectionTimeframe = (typeof REJECTION_TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<RejectionTimeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
};

/** DEMAND = bullish rejection of a low (support). SUPPLY = bearish rejection of a high (resistance). */
export type ZoneDirection = 'DEMAND' | 'SUPPLY';

/** Event lifecycle. A candidate is either confirmed by follow-through, failed, or still pending at the end of data. */
export type RejectionEventStatus = 'CANDIDATE' | 'CONFIRMED' | 'FAILED';

/**
 * Zone lifecycle. Zones are only created from CONFIRMED events, so there is no zone-level CANDIDATE or CONFIRMED state.
 * Transitions are monotonic in time and recorded in `RejectionZone.transitions`.
 */
export type RejectionZoneStatus = 'ACTIVE' | 'TESTED' | 'WEAKENING' | 'BROKEN' | 'RECLAIMED' | 'EXPIRED';

/**
 * Raw OHLCV fields as the exchange reports a kline, already converted to numbers. `openTime` is the bar start in ms UTC.
 * `takerBuyBaseVolume` is the base volume bought by aggressors (Binance `takerBuyBaseAssetVolume`).
 */
export interface OhlcvInput {
  symbol: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
  takerBuyBaseVolume: number;
  trades: number;
}

/** A 1m input bar. Only validated 1m bars enter the canonical store. */
export type MinuteInput = OhlcvInput;

export interface FlowBar {
  symbol: string;
  timeframe: RejectionTimeframe;
  /** Bar start, ms UTC, aligned to the timeframe. */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
  takerBuyBaseVolume: number;
  trades: number;
  /** Number of aligned 1m candles this bar was built from. */
  minuteCount: number;
  /** True only when every 1m candle of the bar is present, valid and in order. */
  complete: boolean;
}

/** The moment a bar becomes known: the first millisecond after it closes. Lifecycle and detection use this, never openTime. */
export const barKnownAt = (bar: Pick<FlowBar, 'openTime' | 'timeframe'>): number => bar.openTime + TIMEFRAME_MS[bar.timeframe];

export interface RejectionConfig {
  /** Wilder ATR period, in bars of the timeframe under analysis. */
  atrPeriod: number;
  /** Number of prior complete bars used for the median quote-volume baseline. */
  volumeWindow: number;
  /** Minimum prior bars before relative volume is defined. */
  minVolumeHistory: number;
  /** Prior bars that define the reference level (lowest low / highest high). */
  lookbackBars: number;
  /** Relative volume the sweep bar must reach. */
  minRelativeVolume: number;
  /** Lower (bullish) or upper (bearish) wick share of the sweep bar's range that the sweep bar must reach. */
  minWickRatio: number;
  /** Bars after the sweep bar in which follow-through must appear. Also the per-direction cooldown length. */
  confirmBars: number;
  /** Displacement from the reclaimed close, in ATR units, that must occur within `confirmBars`. */
  minReversalAtr: number;
}

export interface RejectionEvent {
  id: string;
  symbol: string;
  timeframe: RejectionTimeframe;
  direction: ZoneDirection;
  /** ABSORPTION_LIKE: sell-led flow (for DEMAND) that price nevertheless reclaimed. REJECTION: any other reclaim. */
  kind: 'REJECTION' | 'ABSORPTION_LIKE';
  status: RejectionEventStatus;
  /** Set when status is FAILED. */
  failReason: string | null;
  /** Sweep bar open time. */
  sweepOpenTime: number;
  /** Known-at time of the confirming (or failing) bar. Null while CANDIDATE. */
  resolvedAt: number | null;
  /** Reference level that was swept and reclaimed: the lowest low (DEMAND) or highest high (SUPPLY) of prior bars. */
  referenceLevel: number;
  /** Sweep extreme: the sweep bar's low (DEMAND) or high (SUPPLY). */
  extreme: number;
  /** Zone interval: DEMAND [extreme, referenceLevel]; SUPPLY [referenceLevel, extreme]. */
  zoneLow: number;
  zoneHigh: number;
  /** Sweep bar close (the reclaim point). */
  reclaimClose: number;
  atr: number;
  relativeVolume: number;
  volumeDelta: number;
  deltaRatio: number;
  /** Wick share of the sweep bar's range, on the swept side. */
  wickRatio: number;
  closeLocation: number;
  /** Displacement from the reclaim close, in ATR, at resolution (or the window's maximum when FAILED). */
  reversalAtr: number | null;
  /** Bars after the sweep bar at which the event resolved. */
  reversalBars: number | null;
  evidence: string[];
}

export interface ZoneTransition {
  status: RejectionZoneStatus;
  /** Known-at time of the bar that caused the transition. */
  at: number;
  reason: string;
}

export interface ZoneStrengthComponents {
  /** Mean reversal in ATR, saturating at 2 ATR. */
  reversal: number;
  /** Mean relative volume, saturating at 3x. */
  volume: number;
  /** Mean absolute delta ratio: how one-sided the flow was at the level. */
  delta: number;
  /** Mean reversal speed: 1 when the displacement arrives on the sweep's next bar, falling to 1/confirmBars. */
  speed: number;
  /** Count of reinforcing rejections, saturating at 4. Repeats at one level are evidence, not independent setups. */
  confluence: number;
  /** Weakness from repeated tests (and 1 once broken). */
  weakness: number;
}

export interface ZoneStrength {
  /** 0..100 = 100 × clamp01(0.25R + 0.20V + 0.15D + 0.15S + 0.25C − 0.50W). Initial weights, not validated. */
  score: number;
  components: ZoneStrengthComponents;
}

export interface RejectionZone {
  id: string;
  symbol: string;
  timeframe: RejectionTimeframe;
  direction: ZoneDirection;
  lowerBound: number;
  upperBound: number;
  status: RejectionZoneStatus;
  /** Known-at time of the first confirming rejection. */
  createdAt: number;
  createdIndex: number;
  lastRejectionAt: number;
  rejectionCount: number;
  testCount: number;
  lastTestedAt: number | null;
  brokenAt: number | null;
  reclaimedAt: number | null;
  expiredAt: number | null;
  transitions: ZoneTransition[];
  events: RejectionEvent[];
  strength: ZoneStrength;
}

export interface ZoneConfluence {
  direction: ZoneDirection;
  lowerBound: number;
  upperBound: number;
  /** Distinct timeframes whose live zones overlap in this band. Reported, not multiplied into the score. */
  timeframes: RejectionTimeframe[];
  zoneIds: string[];
}
