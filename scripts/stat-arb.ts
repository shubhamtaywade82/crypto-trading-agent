/**
 * Statistical-arbitrage pairs research CLI (research plane only).
 *
 *   npx tsx scripts/stat-arb.ts --a PATH --b PATH [--cal N] [--entry Z] [--exit Z] [--stop Z]
 *                               [--cost BPS] [--hold N] [--out PATH] [--synthetic]
 *
 * Inputs --a and --b: JSON files, each an array of close prices (aligned by index, same bar frequency).
 * With --synthetic, a deterministic cointegrated pair (BTC-like driver + synthetic perp tracking it with an
 * AR(1) basis) is analyzed instead, so the pipeline can be exercised without data.
 *
 * The study runs a chronological walk-forward: the hedge ratio and spread statistics are calibrated on a
 * trailing window, trades happen on the bars that follow, and every round trip is charged the configured
 * cost in bps of gross notional. Correlation is reported for what it is — NOT a cointegration test.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { runPairsStudy, type PairsStudyOptions } from '../src/research/StatArb.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const A_PATH = arg('a', '');
const B_PATH = arg('b', '');
const SYNTHETIC = process.argv.includes('--synthetic');
const CAL = Number.parseInt(arg('cal', '180'), 10);
const ENTRY_Z = Number.parseFloat(arg('entry', '2.0'));
const EXIT_Z = Number.parseFloat(arg('exit', '0.5'));
const STOP_Z = Number.parseFloat(arg('stop', '3.5'));
const COST_BPS = Number.parseFloat(arg('cost', '8'));
const HOLD = Number.parseInt(arg('hold', '100'), 10);
const OUT = arg('out', 'data/stat-arb-report.json');

/** Deterministic synthetic cointegrated pair: x is a random walk, y = 1.2*x + AR(1) basis. */
function syntheticPair(n: number, seed: number): { a: number[]; b: number[] } {
  const rand = mulberry32(seed);
  const normal = (): number => {
    let u = rand();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const x: number[] = [100];
  for (let i = 1; i < n; i += 1) x.push(Math.max(1, x[i - 1] + normal() * 0.8));
  let basis = 0;
  const a: number[] = [];
  for (let i = 0; i < n; i += 1) {
    basis = 0.75 * basis + normal() * 1.5; // stationary AR(1) around 0
    a.push(1.2 * x[i] + basis + 40);
  }
  return { a, b: x };
}

function loadPrices(filePath: string, label: string): number[] {
  if (!existsSync(filePath)) {
    console.error(`${label} file not found: ${filePath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) {
    console.error(`${label} file must be a JSON array of close prices`);
    process.exit(1);
  }
  const prices = (raw as unknown[]).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
  if (prices.length < 60) {
    console.error(`${label}: need at least 60 prices, got ${prices.length}`);
    process.exit(1);
  }
  return prices;
}

function main(): void {
  const a = SYNTHETIC ? syntheticPair(1500, 42).a : loadPrices(A_PATH, '--a');
  const b = SYNTHETIC ? syntheticPair(1500, 42).b : loadPrices(B_PATH, '--b');
  if (a.length !== b.length) {
    console.error(`--a and --b must be aligned (got ${a.length} vs ${b.length} prices)`);
    process.exit(1);
  }

  const options: PairsStudyOptions = {
    calibrationWindow: CAL,
    entryZ: ENTRY_Z,
    exitZ: EXIT_Z,
    stopZ: STOP_Z,
    costBps: COST_BPS,
    maxHoldBars: HOLD,
  };
  const result = runPairsStudy(a, b, options);

  console.log('=== Statistical arbitrage pairs study (research plane) ===');
  console.log(`bars: ${result.nBars}${SYNTHETIC ? ' (synthetic cointegrated pair)' : ''} | calibration window: ${CAL} | entry |z|>=${ENTRY_Z}, exit |z|<=${EXIT_Z}, stop |z|>=${STOP_Z}, max hold ${HOLD} bars`);
  console.log(`round-trip cost: ${COST_BPS} bps of gross notional`);
  console.log('');
  if (result.fullSample) {
    const eg = result.fullSample;
    console.log('--- Full-sample Engle-Granger (context only; trading never saw it) ---');
    console.log(`hedge ratio beta=${eg.ols.beta.toFixed(4)} (R^2 ${eg.ols.r2.toFixed(3)}) | level correlation ${eg.correlation.toFixed(3)}`);
    console.log(`ADF on residuals: ${eg.adf.statistic.toFixed(3)} vs 5% critical ${eg.adf.criticalValues['5%']} => cointegrated: ${eg.cointegrated ? 'YES' : 'no'}`);
    console.log(`spread half-life: ${eg.halfLife !== null ? `${eg.halfLife.toFixed(1)} bars` : 'not mean-reverting'}`);
  }
  console.log('');
  console.log('--- Walk-forward folds (calibrated on trailing window only) ---');
  console.log(`folds: ${result.folds.length} | cointegration detection rate: ${(result.foldCointegrationRate * 100).toFixed(0)}%`);
  for (const f of result.folds.slice(0, 12)) {
    console.log(`  bars ${f.from}-${f.to}: beta=${f.beta.toFixed(3)} | ADF ${f.adfStat.toFixed(2)} ${f.cointegrated ? '(coint)' : ''} | HL ${f.halfLife !== null ? f.halfLife.toFixed(0) : 'n/a'} | trades ${f.trades}`);
  }
  console.log('');
  console.log('--- Round-trip economics (net of costs) ---');
  if (result.nTrades === 0) {
    console.log('no round trips triggered');
  } else {
    console.log(`trades: ${result.nTrades} | win rate ${(result.winRate * 100).toFixed(1)}% | mean ${(result.meanPnlPct ?? 0).toFixed(3)}% of notional | mean hold ${result.meanHoldBars?.toFixed(1)} bars`);
    if (result.bootstrap) {
      console.log(`bootstrap 90% CI of mean: [${result.bootstrap.ciLow.toFixed(3)}%, ${result.bootstrap.ciHigh.toFixed(3)}%] | null-centered p=${result.bootstrap.pValue.toFixed(4)}`);
    }
  }
  for (const w of result.warnings) console.log(`warning: ${w}`);
  console.log('');
  console.log('NOTE: a positive full-sample result is NOT promotion evidence. Cointegrating relationships');
  console.log('break; funding, execution correlation and regime shifts eat the spread; and n<30 round trips');
  console.log('carry no statistical weight. This study exists to kill bad pairs early, not to trade them.');

  try {
    mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    writeFileSync(path.resolve(OUT), JSON.stringify({ generatedAt: new Date().toISOString(), result }, null, 2), 'utf8');
    console.log(`\nreport written to ${OUT}`);
  } catch (err) {
    console.error(`failed to write report artifact: ${(err as Error).message}`);
  }
}

main();
