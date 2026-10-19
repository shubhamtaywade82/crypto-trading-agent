#!/usr/bin/env node
/**
 * event-study — descriptive ALMA event statistics on local, validated snapshots.
 *
 * Implements Phase 1/2 of docs/RESEARCH_PROTOCOL.md: event labels that were
 * fixed in src/events.ts before any result inspection, scored by
 * direction-adjusted forward returns from the next bar's open over a fixed
 * horizon, with MFE/MAE and tail exclusion.
 *
 * This is NOT a backtest: no fills, no stops, no fees, no slippage, no
 * funding. A positive hit rate says nothing about profitability by itself.
 * Cost-adjusted evaluation comes later through the repository's existing
 * backtesting engine, never here.
 *
 * Includes an inverted-direction negative control: if the inverted signal
 * performs about as well as the signal itself, the "edge" is noise.
 *
 * Usage (after scripts/fetch-klines.ts wrote snapshots):
 *   npx tsx research/alma/scripts/event-study.ts \
 *     --symbol SOLUSDT --timeframes 15m,1h,2h,4h,1d \
 *     --fast 9 --slow 21 --offset 0.85 --sigma 6 --source close \
 *     --atr 14 --horizon 6
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alma, sourceSeries } from '../src/alma.js';
import { atrWilder } from '../src/atr.js';
import { validateCandles } from '../src/data-quality.js';
import {
  detectCrossovers,
  detectPullbackAfterCross,
  forwardOutcome,
  medianOf,
  summarizeEvents,
  type CrossEvent,
  type Direction,
  type EventStats,
} from '../src/events.js';
import {
  ALMA_SOURCES,
  NATIVE_TIMEFRAMES,
  type AlmaSource,
  type Candle,
  type NativeTimeframe,
} from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATA_ROOT = resolve(REPO_ROOT, 'data', 'research', 'alma');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes('--' + name);
}

function num(name: string, fallback: number, min: number, max?: number): number {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    throw new Error('--' + name + ' must be a number in [' + min + ', ' + (max ?? 'inf') + '], got ' + raw);
  }
  return value;
}

function boolArg(name: string, fallback: boolean): boolean {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) return true;
  return next === 'true' || next === '1';
}

function loadSnapshot(path: string, timeframe: NativeTimeframe, symbol: string): Candle[] {
  if (!existsSync(path)) {
    throw new Error('missing snapshot ' + path + ' — run scripts/fetch-klines.ts first');
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('snapshot ' + path + ' is not a candle array');
  const candles = parsed as Candle[];
  const report = validateCandles(candles, timeframe);
  if (!report.valid) {
    throw new Error(
      'snapshot ' + symbol + ' ' + timeframe + ' failed validation: ' + report.issues.slice(0, 5).join('; '),
    );
  }
  return candles;
}

function manifestSha256(manifestDir: string, symbol: string, timeframe: NativeTimeframe): string | null {
  const path = resolve(manifestDir, symbol + '-' + timeframe + '.manifest.json');
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sha256?: unknown };
  return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
}

function flip(direction: Direction): Direction {
  return direction === 1 ? -1 : 1;
}

function scoreEvents(
  events: readonly CrossEvent[],
  candles: readonly Candle[],
  horizon: number,
  invert: boolean,
): EventStats {
  const scored = events.map((event) => {
    const direction = invert ? flip(event.direction) : event.direction;
    return { direction, outcome: forwardOutcome(candles, event.index, direction, horizon) };
  });
  return summarizeEvents(scored);
}

interface TfResult {
  bars: number;
  firstOpenTime: number;
  lastOpenTime: number;
  manifestSha256: string | null;
  crossOnly: EventStats;
  crossWithSlope: EventStats;
  crossThenPullbackThenReject: EventStats;
  crossOnlyInverted: EventStats;
  baselineLongDrift: { bars: number; medianPct: number | null; meanPct: number | null };
}

function baselineDrift(candles: readonly Candle[], horizon: number): TfResult['baselineLongDrift'] {
  const pcts: number[] = [];
  for (let i = 0; i + 1 + horizon - 1 <= candles.length - 1; i++) {
    const entry = candles[i + 1].open;
    const exit = candles[i + horizon].close;
    if (entry > 0) pcts.push(exit / entry - 1);
  }
  const mean = pcts.length > 0 ? pcts.reduce((sum, value) => sum + value, 0) / pcts.length : null;
  return { bars: pcts.length, medianPct: medianOf(pcts), meanPct: mean };
}

function formatPct(value: number | null): string {
  if (value === null) return 'n/a';
  const scaled = value * 100;
  return (scaled >= 0 ? '+' : '') + scaled.toFixed(4) + '%';
}

function formatRate(stats: EventStats): string {
  const rate = stats.hitRate === null ? 'n/a' : (stats.hitRate * 100).toFixed(1) + '%';
  return stats.events + ' ev, ' + rate;
}

async function main(): Promise<void> {
  const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('invalid --symbol');

  const rawDir = resolve(arg('raw-dir', resolve(DATA_ROOT, 'raw')));
  const manifestDir = resolve(arg('manifest-dir', resolve(DATA_ROOT, 'manifests')));
  const outPath = resolve(arg('out', resolve(DATA_ROOT, 'events', 'event-study.json')));

  const requested = arg('timeframes', '15m,1h,2h,4h,1d')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = requested.filter((tf) => !(NATIVE_TIMEFRAMES as readonly string[]).includes(tf));
  if (invalid.length) {
    throw new Error('unsupported timeframe(s): ' + invalid.join(', ') + '. Supported: ' + NATIVE_TIMEFRAMES.join(', '));
  }

  const available = requested.filter((tf) => existsSync(resolve(rawDir, symbol + '-' + tf + '.json')));
  const missing = requested.filter((tf) => !available.includes(tf));
  if (available.length === 0) {
    throw new Error(
      'no local snapshots for ' + symbol + ' under ' + rawDir +
      (missing.length ? ' (missing: ' + missing.join(', ') + ')' : '') +
      ' — run scripts/fetch-klines.ts first',
    );
  }

  const fastLength = num('fast', 9, 1);
  const slowLength = num('slow', 21, 1);
  if (fastLength >= slowLength) throw new Error('--fast must be strictly less than --slow');
  const offset = num('offset', 0.85, 0, 1);
  const sigma = num('sigma', 6, 0.0001);
  const source = arg('source', 'close');
  if (!(ALMA_SOURCES as readonly string[]).includes(source)) {
    throw new Error('unsupported --source: ' + source + '. Supported: ' + ALMA_SOURCES.join(', '));
  }
  const atrLength = num('atr', 14, 1);
  const horizon = num('horizon', 6, 1);
  const slopeLookback = num('slope-lookback', 1, 1);
  const requireSlowSlope = boolArg('require-slow-slope', true);
  const extendAtr = num('extend-atr', 0.25, 0);
  const touchTolAtr = num('touch-tol-atr', 0.05, 0);
  const maxBarsAfterCross = num('max-bars-after-cross', 12, 1);
  const lineKind = arg('line', 'fast');
  if (lineKind !== 'fast' && lineKind !== 'slow') throw new Error("--line must be 'fast' or 'slow'");
  const invertControl = hasFlag('invert-control');

  const results: Record<string, TfResult> = {};
  const datasets: Record<string, object> = {};

  for (const timeframe of available as NativeTimeframe[]) {
    const path = resolve(rawDir, symbol + '-' + timeframe + '.json');
    const candles = loadSnapshot(path, timeframe, symbol);
    const series = sourceSeries(candles, source as AlmaSource);
    const fastSeries = alma(series, { length: fastLength, offset, sigma });
    const slowSeries = alma(series, { length: slowLength, offset, sigma });
    const atrSeries = atrWilder(candles, atrLength);
    const pullbackLine = lineKind === 'fast' ? fastSeries : slowSeries;

    const crosses = detectCrossovers(fastSeries, slowSeries, candles);
    const crossesWithSlope = detectCrossovers(fastSeries, slowSeries, candles, {
      requireSlowSlopeAgreement: true,
      slopeLookbackBars: slopeLookback,
    });
    const pullbacks = crosses
      .map((cross) =>
        detectPullbackAfterCross(
          candles, pullbackLine, slowSeries, atrSeries, cross, lineKind,
          { extendAtr, touchTolAtr, maxBarsAfterCross, requireSlowSlope, slopeLookbackBars: slopeLookback },
        ),
      )
      .filter((event): event is NonNullable<typeof event> => event !== null)
      .map((event): CrossEvent => ({ index: event.index, openTime: event.openTime, direction: event.direction }));

    results[timeframe] = {
      bars: candles.length,
      firstOpenTime: candles[0].openTime,
      lastOpenTime: candles[candles.length - 1].openTime,
      manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
      crossOnly: scoreEvents(crosses, candles, horizon, false),
      crossWithSlope: scoreEvents(crossesWithSlope, candles, horizon, false),
      crossThenPullbackThenReject: scoreEvents(pullbacks, candles, horizon, false),
      crossOnlyInverted: invertControl ? scoreEvents(crosses, candles, horizon, true) : summarizeEvents([]),
      baselineLongDrift: baselineDrift(candles, horizon),
    };
    datasets[timeframe] = {
      file: path,
      bars: candles.length,
      manifestSha256: results[timeframe].manifestSha256,
    };

    const r = results[timeframe];
    console.log(
      timeframe.padEnd(4) +
      ' bars=' + String(r.bars).padStart(6) +
      '  cross ' + formatRate(r.crossOnly).padEnd(18) +
      ' +slope ' + formatRate(r.crossWithSlope).padEnd(18) +
      ' ' + lineKind + '-pullback ' + formatRate(r.crossThenPullbackThenReject).padEnd(18) +
      (invertControl ? ' inverted ' + formatRate(r.crossOnlyInverted).padEnd(18) : '') +
      ' drift ' + formatPct(r.baselineLongDrift.medianPct),
    );
  }

  const report = {
    schemaVersion: 1,
    kind: 'ALMA_EVENT_STUDY',
    status: 'DESCRIPTIVE_NOT_COST_ADJUSTED',
    generatedAt: new Date().toISOString(),
    instrument: { symbol, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      fastLength, slowLength, offset, sigma, source,
      atrLength, horizon, slopeLookback, requireSlowSlope,
      extendAtr, touchTolAtr, maxBarsAfterCross, pullbackLine: lineKind,
      eventFamilies: ['cross_only', 'cross_with_slope', 'cross_then_pullback_then_reject'],
      negativeControl: invertControl ? 'inverted_direction_on_cross_only' : 'not_requested',
      executionReference: 'next_bar_open_to_close_N_bars_later',
    },
    datasets,
    results,
    caveats: [
      'Descriptive event statistics only; no fills, stops, fees, slippage or funding.',
      'A positive hit rate does not imply a profitable strategy.',
      'Small event counts are not evidence of anything; require many events before drawing conclusions.',
    ],
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath);
  console.log('Descriptive statistics only — not fee-adjusted, not a backtest, not a trade signal.');
}

main().catch((error: unknown) => {
  console.error('ALMA event study failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
