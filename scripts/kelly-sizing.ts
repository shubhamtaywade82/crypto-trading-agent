/**
 * Kelly criterion sizing-analysis CLI (research-only).
 *
 *   npx tsx scripts/kelly-sizing.ts [--ledger PATH] [--iterations N] [--seed N] [--confidence L] [--out PATH]
 *
 * Estimates the log-optimal Kelly fraction for the ledger's resolved trade series, bootstraps its
 * confidence interval, and prints the fractional-Kelly recommendations professionals actually use.
 *
 * The output is ADVISORY. The live RiskEngine's per-trade risk budget, portfolio risk cap and
 * liquidation-distance checks remain the authority on position size; nothing here feeds the trading core.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SetupOutcomeLedger } from '../src/learning/SetupOutcomeLedger.js';
import { estimateKelly } from '../src/risk/KellySizer.js';
import { tradeSharpeStats } from '../src/research/ExperimentRunner.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const LEDGER_PATH = arg('ledger', 'data/setup-outcomes.jsonl');
const ITERATIONS = Number.parseInt(arg('iterations', '2000'), 10);
const SEED = Number.parseInt(arg('seed', '42'), 10);
const CONFIDENCE = Number.parseFloat(arg('confidence', '0.9'));
const OUT = arg('out', 'data/kelly-report.json');

function main(): void {
  if (!existsSync(LEDGER_PATH)) {
    console.error(`ledger not found: ${LEDGER_PATH}`);
    console.error('Run the research plane (npm run self-improve) or a replay to populate it, or pass --ledger PATH.');
    process.exit(1);
  }
  const ledger = new SetupOutcomeLedger(LEDGER_PATH, { feeRate: 0.0004, slippageRate: 0.0002 });
  const records = ledger.all().filter((r) => r.entryTouchedAt !== null && r.netR !== null);
  if (records.length === 0) {
    console.error('no resolved trades (entry touched + known outcome) in the ledger — nothing to size');
    process.exit(1);
  }

  const samples = records.map((r) => ({
    netR: r.netR as number,
    cluster: new Date(r.createdAt).toISOString().slice(0, 10),
  }));
  const kelly = estimateKelly(samples, { iterations: ITERATIONS, seed: SEED, confidence: CONFIDENCE });
  const sharpe = tradeSharpeStats(samples.map((s) => s.netR));

  console.log('=== Kelly criterion sizing analysis (research-only) ===');
  console.log(`trades: ${kelly.n} | win rate ${(kelly.winRate * 100).toFixed(1)}% | mean ${kelly.meanNetR.toFixed(3)}R | sd ${kelly.stdNetR.toFixed(3)}R`);
  if (sharpe) console.log(`per-trade Sharpe ${sharpe.sharpePerTrade.toFixed(3)} | skew ${sharpe.skewness.toFixed(2)} | excess kurtosis ${sharpe.excessKurtosis.toFixed(2)}`);
  console.log('');
  console.log(`binary Kelly (reference) : ${(kelly.kellyBinary * 100).toFixed(2)}%  — closed form f* = (bp - q)/b`);
  console.log(`log-optimal Kelly        : ${(kelly.kellyLogOptimal * 100).toFixed(2)}%  — maximizes E[log(1 + fR)] on the empirical distribution`);
  console.log(`bootstrap ${CONFIDENCE * 100}% CI       : [${(kelly.ciLow * 100).toFixed(2)}%, ${(kelly.ciHigh * 100).toFixed(2)}%] (median ${(kelly.median * 100).toFixed(2)}%)`);
  console.log(`expected log growth      : ${kelly.expectedLogGrowth.toFixed(5)} per trade at the optimum`);
  console.log('');
  console.log(`half Kelly               : ${(kelly.halfKelly * 100).toFixed(2)}%`);
  console.log(`quarter Kelly            : ${(kelly.quarterKelly * 100).toFixed(2)}%  — the usual professional default`);
  console.log('');
  console.log(`evidence: ${kelly.evidence}`);
  for (const w of kelly.warnings) console.log(`warning: ${w}`);
  console.log('');
  console.log('NOTE: full Kelly assumes the estimated edge is the TRUE edge. Estimation error, correlated');
  console.log('positions, regime shifts and fat tails all argue for the fractional values above, and the live');
  console.log('risk engine still caps every position independently of this analysis.');

  try {
    mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    writeFileSync(path.resolve(OUT), JSON.stringify({ generatedAt: new Date().toISOString(), kelly }, null, 2), 'utf8');
    console.log(`\nreport written to ${OUT}`);
  } catch (err) {
    console.error(`failed to write report artifact: ${(err as Error).message}`);
  }
}

main();
