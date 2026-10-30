/**
 * Volatility-clustering diagnostics CLI.
 *
 *   npx tsx scripts/volatility-clustering.ts --closes PATH [--lags N] [--lambda L] [--window N] [--out PATH]
 *   npx tsx scripts/volatility-clustering.ts --synthetic            # deterministic GARCH demo
 *
 * Input format for --closes: a JSON file that is either
 *   - an array of close prices: [100.5, 101.2, ...]
 *   - an array of candle objects with a numeric `close` field (e.g. exported klines)
 *
 * Reports:
 *   - Ljung-Box ARCH-effect tests on squared and absolute returns (is volatility clustered at all?)
 *   - the autocorrelation structure of |r| and r^2
 *   - a chronological out-of-sample horse race of one-step-ahead volatility forecasts
 *     (naive constant, rolling window, EWMA, GARCH(1,1)) scored by QLIKE and MSE
 *   - an operator-facing recommendation: which model (if any) the risk plane should use
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mulberry32 } from '../src/research/Bootstrap.js';
import {
  logReturns,
  volatilityClusteringReport,
} from '../src/research/VolatilityClustering.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const CLOSES_PATH = arg('closes', '');
const SYNTHETIC = process.argv.includes('--synthetic');
const LAGS = Number.parseInt(arg('lags', '10'), 10);
const LAMBDA = Number.parseFloat(arg('lambda', '0.94'));
const WINDOW = Number.parseInt(arg('window', '30'), 10);
const OUT = arg('out', 'data/volatility-clustering-report.json');

/** Deterministic GARCH(1,1) series for demonstration: omega=2e-6, alpha=0.10, beta=0.88. */
function syntheticGarchReturns(n: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const normal = (): number => {
    let u = rand();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const omega = 2e-6;
  const alpha = 0.1;
  const beta = 0.88;
  let sigma2 = omega / (1 - alpha - beta);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = normal() * Math.sqrt(sigma2);
    out.push(r);
    sigma2 = omega + alpha * r * r + beta * sigma2;
  }
  return out;
}

function loadCloses(filePath: string): number[] {
  if (!existsSync(filePath)) {
    console.error(`closes file not found: ${filePath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) {
    console.error('closes file must be a JSON array');
    process.exit(1);
  }
  const closes = raw
    .map((entry) => (typeof entry === 'number' ? entry : Number((entry as { close?: unknown }).close)))
    .filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 60) {
    console.error(`need at least 60 close prices, got ${closes.length}`);
    process.exit(1);
  }
  return closes;
}

function main(): void {
  const returns = SYNTHETIC
    ? syntheticGarchReturns(3000, 42)
    : logReturns(loadCloses(CLOSES_PATH));

  const report = volatilityClusteringReport(returns, {
    lags: LAGS,
    lambda: LAMBDA,
    rollingWindow: WINDOW,
  });

  console.log('=== Volatility clustering diagnostics ===');
  console.log(`returns: ${report.n}${SYNTHETIC ? ' (synthetic GARCH demo)' : ''}`);
  console.log('');
  if (report.arch) {
    console.log('--- ARCH-effect tests ---');
    console.log(`Ljung-Box on r^2 : Q=${report.arch.lbSquared.statistic.toFixed(1)} df=${report.arch.lbSquared.df} p=${report.arch.lbSquared.pValue.toExponential(2)}`);
    console.log(`Ljung-Box on |r| : Q=${report.arch.lbAbsolute.statistic.toFixed(1)} df=${report.arch.lbAbsolute.df} p=${report.arch.lbAbsolute.pValue.toExponential(2)}`);
    console.log(`ACF(r^2) lags 1-${report.arch.acfSquared.length}: ${report.arch.acfSquared.map((v) => v.toFixed(2)).join(' ')}`);
    console.log(`volatility clusters (p < ${report.arch.alpha}): ${report.arch.clusters ? 'YES' : 'no'}`);
  } else {
    console.log('not enough data for ARCH-effect tests');
  }
  console.log('');
  if (report.forecasts) {
    console.log(`--- Out-of-sample forecast comparison (train ${report.forecasts.trainN} / test ${report.forecasts.testN}) ---`);
    for (const m of report.forecasts.models) {
      console.log(`${m.model.padEnd(8)} QLIKE ${m.qlike.toFixed(5)} | MSE ${m.mse.toExponential(3)}`);
    }
    if (report.forecasts.garch) {
      const g = report.forecasts.garch;
      console.log(`GARCH(1,1): omega=${g.omega.toExponential(3)} alpha=${g.alpha.toFixed(2)} beta=${g.beta.toFixed(2)} | persistence=${g.persistence.toFixed(3)}`);
      console.log(`           shock half-life ${g.shockHalfLife !== null ? `${g.shockHalfLife.toFixed(1)} bars` : 'n/a'}`);
    }
    console.log(`best model by QLIKE: ${report.forecasts.best}`);
    console.log(`GARCH earns its complexity vs EWMA: ${report.forecasts.sophisticatedModelEarnsItsComplexity ? 'YES' : 'no'}`);
  } else {
    console.log('not enough data for out-of-sample forecast evaluation');
  }
  console.log('');
  console.log(`recommendation: ${report.recommendation}`);

  try {
    mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    writeFileSync(path.resolve(OUT), JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2), 'utf8');
    console.log(`\nreport written to ${OUT}`);
  } catch (err) {
    console.error(`failed to write report artifact: ${(err as Error).message}`);
  }
}

main();
