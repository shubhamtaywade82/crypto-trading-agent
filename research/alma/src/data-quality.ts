import type { Candle, NativeTimeframe } from './types.js';

const FIXED_INTERVAL_MS: Partial<Record<NativeTimeframe, number>> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
};

export interface CandleValidationReport {
  valid: boolean;
  bars: number;
  issueCount: number;
  gapCount: number;
  duplicateCount: number;
  issues: string[];
}

export function nextOpenTime(openTime: number, timeframe: NativeTimeframe): number {
  const fixed = FIXED_INTERVAL_MS[timeframe];
  if (fixed !== undefined) return openTime + fixed;

  if (timeframe === '1M') {
    const date = new Date(openTime);
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.getTime();
  }
  throw new Error('Unsupported timeframe: ' + timeframe);
}

/** Validates in-place order; intentionally does not sort, deduplicate, repair or fill data. */
export function validateCandles(
  candles: readonly Candle[],
  timeframe: NativeTimeframe,
): CandleValidationReport {
  const issues: string[] = [];
  let gapCount = 0;
  let duplicateCount = 0;

  if (candles.length === 0) {
    return { valid: false, bars: 0, issueCount: 1, gapCount: 0, duplicateCount: 0, issues: ['dataset is empty'] };
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prefix = 'bar[' + i + ']';

    if (!Number.isSafeInteger(c.openTime) || c.openTime < 0) issues.push(prefix + ' has invalid openTime');
    if (!Number.isSafeInteger(c.closeTime) || c.closeTime < c.openTime) issues.push(prefix + ' has invalid closeTime');

    for (const [field, value] of Object.entries({
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    })) {
      if (!Number.isFinite(value)) issues.push(prefix + ' has non-finite ' + field);
    }

    if ([c.open, c.high, c.low, c.close].every(Number.isFinite)) {
      if (c.low <= 0 || c.open <= 0 || c.high <= 0 || c.close <= 0) {
        issues.push(prefix + ' has non-positive OHLC price');
      }
      if (c.high < c.low || c.low > c.open || c.low > c.close || c.high < c.open || c.high < c.close) {
        issues.push(prefix + ' violates OHLC envelope low <= open/close <= high');
      }
    }
    if (Number.isFinite(c.volume) && c.volume < 0) issues.push(prefix + ' has negative volume');

    if (i === 0) continue;
    const previous = candles[i - 1];

    if (c.openTime === previous.openTime) {
      duplicateCount++;
      issues.push(prefix + ' duplicates openTime ' + c.openTime);
      continue;
    }
    if (c.openTime < previous.openTime) {
      issues.push(prefix + ' has non-monotonic openTime');
      continue;
    }

    const expected = nextOpenTime(previous.openTime, timeframe);
    if (c.openTime !== expected) {
      gapCount++;
      const kind = c.openTime > expected ? 'gap or missing candle' : 'unexpected overlapping interval';
      issues.push(prefix + ' has ' + kind + ': expected openTime ' + expected + ', got ' + c.openTime);
    }
  }

  return {
    valid: issues.length === 0,
    bars: candles.length,
    issueCount: issues.length,
    gapCount,
    duplicateCount,
    issues,
  };
}

export function assertValidCandles(
  candles: readonly Candle[],
  timeframe: NativeTimeframe,
): CandleValidationReport {
  const report = validateCandles(candles, timeframe);
  if (!report.valid) {
    throw new Error(
      'Rejected ' + timeframe + ' dataset: ' + report.issueCount + ' issue(s). ' +
      report.issues.slice(0, 10).join('; '),
    );
  }
  return report;
}