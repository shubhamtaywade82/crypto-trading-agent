import type { DataQualityReport, DataQualityStatus } from './types.js';
import type { MarketBriefRawData } from './MarketBriefDataProvider.js';

export interface SafetyThresholds {
  readonly markStaleMs: number;
  readonly candleStaleMs: number;
  readonly derivativesStaleMs: number;
  readonly maxMarkTickerDivergencePct: number;
}

export const DEFAULT_SAFETY_THRESHOLDS: SafetyThresholds = {
  markStaleMs: 30_000,
  candleStaleMs: 45 * 60_000, // 3 * 15m
  derivativesStaleMs: 20 * 60_000, // accommodates Binance 15m statistical publication interval
  maxMarkTickerDivergencePct: 1.0,
};

// Audits single OHLC bar for geometric and physical integrity
function checkBarIntegrity(bar: { open: number; high: number; low: number; close: number }): string | null {
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0) return 'non-positive price in OHLC';
  if (bar.high < bar.low) return 'impossible high < low';
  if (bar.high < Math.max(bar.open, bar.close)) return 'high lower than open/close';
  if (bar.low > Math.min(bar.open, bar.close)) return 'low higher than open/close';
  return null;
}

// Evaluates freshness and divergence tolerances between ticker, mark, and candles
export function assessBriefSafety(
  raw: MarketBriefRawData,
  now: number = Date.now(),
  thresholds: SafetyThresholds = DEFAULT_SAFETY_THRESHOLDS
): DataQualityReport {
  const invalidReasons: string[] = [];
  const degradedReasons: string[] = [];

  const mark = raw.overview.markPrice;
  const last = raw.overview.lastPrice;
  if (!mark || mark <= 0) invalidReasons.push('mark price missing or non-positive');
  if (!last || last <= 0) invalidReasons.push('last ticker price missing or non-positive');

  // Check mark vs last price divergence
  if (mark && last && mark > 0) {
    const divPct = (Math.abs(last - mark) / mark) * 100;
    if (divPct > thresholds.maxMarkTickerDivergencePct) {
      degradedReasons.push(`mark/last price divergence ${divPct.toFixed(2)}% exceeds limit`);
    }
  }

  // Audit candle bars across confirmed timeframes
  for (const [tf, view] of Object.entries(raw.candleViews)) {
    if (!view.confirmed) {
      invalidReasons.push(`missing confirmed candle series for ${tf}`);
      continue;
    }
    const err = checkBarIntegrity(view.confirmed);
    if (err) invalidReasons.push(`corrupted candle on ${tf}: ${err}`);
  }

  // Freshness gates
  const markAge = raw.sourceTimestamps.markPriceAt ? now - raw.sourceTimestamps.markPriceAt : Infinity;
  if (markAge > thresholds.markStaleMs) degradedReasons.push(`mark price stale (${Math.round(markAge / 1000)}s)`);

  const closed15m = raw.candleViews['15m'].confirmed;
  if (closed15m && now - closed15m.closeTime > thresholds.candleStaleMs) {
    degradedReasons.push('latest 15m closed candle is stale');
  }

  const derivAge = raw.sourceTimestamps.derivativesAt ? now - raw.sourceTimestamps.derivativesAt : Infinity;
  if (derivAge > thresholds.derivativesStaleMs) degradedReasons.push('derivatives data stale');

  const status: DataQualityStatus = invalidReasons.length > 0
    ? 'INVALID'
    : degradedReasons.length > 0
      ? 'DEGRADED'
      : 'VALID';

  const reasons = [...invalidReasons, ...degradedReasons];

  return {
    status,
    reasons,
    lastTradeAt: raw.sourceTimestamps.lastTradeAt,
    markPriceAt: raw.sourceTimestamps.markPriceAt,
    derivativesAt: raw.sourceTimestamps.derivativesAt,
  };
}
