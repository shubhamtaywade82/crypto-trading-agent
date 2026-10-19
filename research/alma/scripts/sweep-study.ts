#!/usr/bin/env node
/**
 * sweep-study — descriptive statistics for liquidity sweep-and-reclaim events
 * on local, validated snapshots (same rigor as scripts/event-study.ts).
 *
 * Hypothesis family (definitions fixed in src/sweeps.ts BEFORE any result):
 *   bullish sweep (lows taken + reclaimed) -> reversal-UP hypothesis -> long
 *   bearish mirror                          -> reversal-DOWN hypothesis -> short
 * The inverted-direction control is the continuation hypothesis (breakdown
 * keeps going). If the control matches the signal, the event carries no
 * directional information.
 *
 * Two predeclared variants per run: same-bar reclaim only, and reclaim
 * allowed within 2 bars. Long/short splits are reported separately.
 *
 * Usage:
 *   npx tsx research/alma/scripts/sweep-study.ts \
 *     --symbol SOLUSDT --timeframes 15m,1h,2h,4h,1d \
 *     --swing 3 --horizon 6 --invert-control
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandles } from '../src/data-quality.js';
import { forwardOutcome, medianOf, summarizeEvents, type Direction, type EventStats } from '../src/events.js';
import { detectSweepReclaim, type SweepEvent } from '../src/sweeps.js';
import { NATIVE_TIMEFRAMES, type Candle, type NativeTimeframe } from '../src/types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATA_ROOT = resolve(REPO_ROOT, 'data', 'research', 'alma');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes('--' + name);
}

function num(name: string, fallback: number, min: number): number {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error('--' + name + ' must be a number >= ' + min + ', got ' + raw);
  }
  return value;
}

function loadSnapshot(path: string, timeframe: NativeTimeframe, symbol: string): Candle[] {
  if (!existsSync(path)) {
    throw new Error('missing snapshot ' + path + ' — run scripts/fetch-klines.ts or scripts/alma-snapshot-from-archive.ts first');
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('snapshot ' + path + ' is not a candle array');
  const candles = parsed as Candle[];
  const report = validateCandles(candles, timeframe);
  if (!report.valid) {
    throw new Error('snapshot ' + symbol + ' ' + timeframe + ' failed validation: ' + report.issues.slice(0, 5).join('; '));
  }
  return candles;
}

function manifestSha256(manifestDir: string, symbol: string, timeframe: NativeTimeframe): string | null {
  const path = resolve(manifestDir, symbol + '-' + timeframe + '.manifest.json');
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sha256?: unknown };
  return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
}

function score(events: readonly SweepEvent[], candles: readonly Candle[], horizon: number, filter?: (e: SweepEvent) => boolean, invert = false): EventStats {
  const picked = filter ? events.filter(filter) : events;
  const scored = picked.map((event) => {
    const direction: Direction = invert ? (event.direction === 1 ? -1 : 1) : event.direction;
    return { direction, outcome: forwardOutcome(candles, event.index, direction, horizon) };
  });
  return summarizeEvents(scored);
}

interface FamilyStats {
  all: EventStats;
  long: EventStats;
  short: EventStats;
  inverted: EventStats;
}

function familyStats(events: readonly SweepEvent[], candles: readonly Candle[], horizon: number, invertControl: boolean): FamilyStats {
  return {
    all: score(events, candles, horizon),
    long: score(events, candles, horizon, (e) => e.direction === 1),
    short: score(events, candles, horizon, (e) => e.direction === -1),
    inverted: invertControl ? score(events, candles, horizon, undefined, true) : summarizeEvents([]),
  };
}

function baselineDrift(candles: readonly Candle[], horizon: number): { bars: number; medianPct: number | null; meanPct: number | null } {
  const pcts: number[] = [];
  for (let i = 0; i + 1 + horizon - 1 <= candles.length - 1; i++) {
    const entry = candles[i + 1].open;
    const exit = candles[i + horizon].close;
    if (entry > 0) pcts.push(exit / entry - 1);
  }
  const mean = pcts.length > 0 ? pcts.reduce((sum, value) => sum + value, 0) / pcts.length : null;
  return { bars: pcts.length, medianPct: medianOf(pcts), meanPct: mean };
}

function formatRate(stats: EventStats): string {
  const rate = stats.hitRate === null ? 'n/a' : (stats.hitRate * 100).toFixed(1) + '%';
  return stats.events + ' ev, ' + rate;
}

function formatPct(value: number | null): string {
  if (value === null) return 'n/a';
  const scaled = value * 100;
  return (scaled >= 0 ? '+' : '') + scaled.toFixed(4) + '%';
}

interface TfResult {
  bars: number;
  firstOpenTime: number;
  lastOpenTime: number;
  manifestSha256: string | null;
  driftBaseline: { bars: number; medianPct: number | null; meanPct: number | null };
  variants: Record<string, FamilyStats>;
}

async function main(): Promise<void> {
  const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(symbol)) throw new Error('invalid --symbol');

  const rawDir = resolve(arg('raw-dir', resolve(DATA_ROOT, 'raw')));
  const manifestDir = resolve(arg('manifest-dir', resolve(DATA_ROOT, 'manifests')));
  const outPath = resolve(arg('out', resolve(DATA_ROOT, 'events', 'sweep-study.json')));

  const requested = arg('timeframes', '15m,1h,2h,4h,1d')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = requested.filter((tf) => !(NATIVE_TIMEFRAMES as readonly string[]).includes(tf));
  if (invalid.length) {
    throw new Error('unsupported timeframe(s): ' + invalid.join(', ') + '. Supported: ' + NATIVE_TIMEFRAMES.join(', '));
  }
  const available = requested.filter((tf) => existsSync(resolve(rawDir, symbol + '-' + tf + '.json')));
  if (available.length === 0) {
    throw new Error('no local snapshots for ' + symbol + ' under ' + rawDir + ' — fetch data first');
  }

  const swing = num('swing', 3, 1);
  const horizon = num('horizon', 6, 1);
  const cooldownBars = num('cooldown', 5, 0);
  const invertControl = hasFlag('invert-control');
  // Predeclared variants: same-bar reclaim only (0) and reclaim within 2 bars (2).
  const variants: Array<{ name: string; reclaimWithinBars: number }> = [
    { name: 'same_bar_reclaim', reclaimWithinBars: 0 },
    { name: 'reclaim_within_2', reclaimWithinBars: 2 },
  ];

  const results: Record<string, TfResult> = {};
  const datasets: Record<string, object> = {};

  for (const timeframe of available as NativeTimeframe[]) {
    const candles = loadSnapshot(resolve(rawDir, symbol + '-' + timeframe + '.json'), timeframe, symbol);
    const perVariant: Record<string, FamilyStats> = {};
    const lines: string[] = [];
    for (const variant of variants) {
      const events = detectSweepReclaim(candles, swing, { reclaimWithinBars: variant.reclaimWithinBars, cooldownBars });
      const stats = familyStats(events, candles, horizon, invertControl);
      perVariant[variant.name] = stats;
      lines.push(
        variant.name + ': all ' + formatRate(stats.all) +
        ' | long ' + formatRate(stats.long) +
        ' | short ' + formatRate(stats.short) +
        (invertControl ? ' | inverted ' + formatRate(stats.inverted) : ''),
      );
    }
    const drift = baselineDrift(candles, horizon);
    results[timeframe] = {
      bars: candles.length,
      firstOpenTime: candles[0].openTime,
      lastOpenTime: candles[candles.length - 1].openTime,
      manifestSha256: manifestSha256(manifestDir, symbol, timeframe),
      driftBaseline: drift,
      variants: perVariant,
    };
    datasets[timeframe] = { bars: candles.length, manifestSha256: results[timeframe].manifestSha256 };
    for (const line of lines) console.log(timeframe.padEnd(4) + ' ' + line);
    console.log(timeframe.padEnd(4) + ' drift median ' + formatPct(drift.medianPct) + ' over ' + drift.bars + ' bars');
  }

  const report = {
    schemaVersion: 1,
    kind: 'SWEEP_RECLAIM_EVENT_STUDY',
    status: 'DESCRIPTIVE_NOT_COST_ADJUSTED',
    generatedAt: new Date().toISOString(),
    instrument: { symbol, venue: 'BINANCE_USDM_PERPETUAL' },
    config: {
      swingStrength: swing,
      cooldownBars,
      horizon,
      variants: variants.map((v) => v.name),
      eventDirection: 'reclaim side (fade the sweep)',
      negativeControl: invertControl ? 'inverted_direction (continuation hypothesis)' : 'not_requested',
      executionReference: 'next_bar_open_to_close_N_bars_later',
    },
    datasets,
    results,
    caveats: [
      'Descriptive event statistics only; no fills, stops, fees, slippage or funding.',
      'Event definitions were committed before any result was inspected.',
      'Small event counts are not evidence; require many events before drawing conclusions.',
    ],
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log('\nReport written: ' + outPath);
  console.log('Descriptive statistics only — not fee-adjusted, not a backtest, not a trade signal.');
}

main().catch((error: unknown) => {
  console.error('Sweep study failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
