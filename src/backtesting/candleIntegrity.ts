import type { Candle } from '../types.js';

/**
 * Integrity gate for kline series. Every backtest and sweep passes its candles through here before a number is computed:
 * a gap, a duplicate, an off-grid open time or an impossible OHLC bar fails the run instead of skewing it.
 */

/** Bar-grid window. fromMs and toMs are multiples of intervalMs; the bars expected are openTime in [fromMs, toMs). */
export interface CandleWindow {
  intervalMs: number;
  fromMs: number;
  toMs: number;
}

export type CandleViolationKind = 'invalid_value' | 'ohlc' | 'misaligned' | 'out_of_window' | 'out_of_order' | 'duplicate' | 'gap' | 'count';

export interface CandleViolation {
  kind: CandleViolationKind;
  /** Index into the candles array; null for series-level findings (edge gaps, count). */
  index: number | null;
  detail: string;
}

const iso = (t: number): string => new Date(t).toISOString();

/**
 * Shrinks [fromMs, toMs) onto the bar grid. A partial leading bar is dropped and the forming bar at the end is excluded,
 * so every bar in the result is complete.
 */
export function alignWindow(fromMs: number, toMs: number, intervalMs: number): CandleWindow {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new Error(`intervalMs must be a positive integer, got ${intervalMs}`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error(`window bounds must be finite, got [${fromMs}, ${toMs})`);
  const aligned: CandleWindow = { intervalMs, fromMs: Math.ceil(fromMs / intervalMs) * intervalMs, toMs: Math.floor(toMs / intervalMs) * intervalMs };
  if (aligned.toMs <= aligned.fromMs) throw new Error(`window [${iso(fromMs)}, ${iso(toMs)}) holds no complete ${intervalMs}ms bar`);
  return aligned;
}

/** Number of complete bars the window must contain. */
export const expectedBarCount = (window: CandleWindow): number => (window.toMs - window.fromMs) / window.intervalMs;

/** Every integrity finding for a series, in array order. An empty result means the series is usable. */
export function findCandleViolations(candles: readonly Candle[], window: CandleWindow): CandleViolation[] {
  const { intervalMs, fromMs, toMs } = window;
  const violations: CandleViolation[] = [];
  const add = (kind: CandleViolationKind, index: number | null, detail: string): void => { violations.push({ kind, index, detail }); };

  let previous: number | null = null;
  candles.forEach((c, i) => {
    const at = `candle[${i}] openTime=${c.openTime}`;
    if (!Number.isFinite(c.openTime)) { add('invalid_value', i, `${at}: non-finite openTime`); return; }
    const prices = [c.open, c.high, c.low, c.close];
    if (prices.some((p) => !Number.isFinite(p) || p <= 0) || !Number.isFinite(c.volume) || c.volume < 0) {
      add('invalid_value', i, `${at}: prices must be finite and > 0, volume finite and >= 0 (o=${c.open} h=${c.high} l=${c.low} c=${c.close} v=${c.volume})`);
    } else if (c.low > c.high || Math.min(c.open, c.close) < c.low || Math.max(c.open, c.close) > c.high) {
      add('ohlc', i, `${at}: low <= open/close <= high violated (o=${c.open} h=${c.high} l=${c.low} c=${c.close})`);
    }
    if (c.openTime % intervalMs !== 0) add('misaligned', i, `${at}: not on the ${intervalMs}ms grid`);
    if (c.openTime < fromMs || c.openTime >= toMs) add('out_of_window', i, `${at}: outside [${iso(fromMs)}, ${iso(toMs)})`);
    if (previous !== null) {
      if (c.openTime === previous) add('duplicate', i, `${at}: repeats the previous openTime`);
      else if (c.openTime < previous) add('out_of_order', i, `${at}: earlier than the previous bar (${previous})`);
      else if (c.openTime - previous > intervalMs) add('gap', i, `${at}: ${Math.ceil((c.openTime - previous) / intervalMs) - 1} missing bar(s) after ${previous}`);
    }
    if (previous === null || c.openTime > previous) previous = c.openTime;
  });

  const first = candles[0];
  const last = candles[candles.length - 1];
  if (first && Number.isFinite(first.openTime)) {
    const leading = Math.ceil((first.openTime - fromMs) / intervalMs);
    if (leading > 0) add('gap', null, `${leading} missing leading bar(s) before ${iso(first.openTime)}`);
  }
  if (last && Number.isFinite(last.openTime)) {
    const trailing = Math.ceil((toMs - last.openTime) / intervalMs) - 1;
    if (trailing > 0) add('gap', null, `${trailing} missing trailing bar(s) after ${iso(last.openTime)}`);
  }

  const expected = expectedBarCount(window);
  if (candles.length !== expected) add('count', null, `expected ${expected} complete bars in [${iso(fromMs)}, ${iso(toMs)}), got ${candles.length}`);
  return violations;
}

export class CandleIntegrityError extends Error {
  readonly window: CandleWindow;
  readonly violations: CandleViolation[];

  constructor(label: string, window: CandleWindow, violations: CandleViolation[], hint?: string) {
    const shown = violations.slice(0, 10).map((v) => `  - [${v.kind}] ${v.detail}`);
    if (violations.length > 10) shown.push(`  ... ${violations.length - 10} more`);
    if (hint) shown.push(`  hint: ${hint}`);
    super([`${label}: ${violations.length} candle integrity violation(s)`, ...shown].join('\n'));
    this.name = 'CandleIntegrityError';
    this.window = window;
    this.violations = violations;
  }
}

/** Throws CandleIntegrityError unless the series is complete, contiguous, in-window and well-formed. */
export function assertCandleIntegrity(candles: readonly Candle[], window: CandleWindow, label: string, hint?: string): void {
  const violations = findCandleViolations(candles, window);
  if (violations.length > 0) throw new CandleIntegrityError(label, window, violations, hint);
}
