/**
 * Monte Carlo risk-simulation CLI.
 *
 *   npx tsx scripts/monte-carlo-risk.ts [--ledger PATH] [--sims N] [--risk PCT] [--seed N]
 *                                        [--mode iid|block|regime] [--block N] [--max-dd PCT]
 *                                        [--ruin PCT] [--leverage L] [--horizon N] [--out PATH]
 *
 * Loads the SetupOutcomeLedger (hypothetical, cost-adjusted trade series), simulates thousands of seeded
 * equity paths under a fixed-fractional sizing model, and reports:
 *
 *   - the distribution of final equity / final return,
 *   - the max-drawdown distribution and the probability of breaching the kill-switch drawdown limit,
 *   - the probability of ruin (equity hitting the configured ruin floor),
 *   - the probability and frequency of liquidation events under the leverage assumption,
 *   - the recovery-time (longest underwater stretch) distribution,
 *   - binomial standard errors on every tail probability,
 *   - a Kelly sizing analysis of the same trade series (research-only).
 *
 * This quantifies the CONSEQUENCES of the trade distribution. It cannot manufacture an edge: a
 * negative-expectancy series produces a devastating report by design, and that is the point.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SetupOutcomeLedger, type SetupOutcomeRecord } from '../src/learning/SetupOutcomeLedger.js';
import { runMonteCarlo, type MonteCarloTrade, type ResampleMode } from '../src/research/MonteCarlo.js';
import { estimateKelly, type KellySample } from '../src/risk/KellySizer.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const LEDGER_PATH = arg('ledger', 'data/setup-outcomes.jsonl');
const SIMS = Number.parseInt(arg('sims', '5000'), 10);
const RISK_PCT = Number.parseFloat(arg('risk', '1')) / 100;
const SEED = Number.parseInt(arg('seed', '42'), 10);
const MODE = arg('mode', 'block') as ResampleMode;
const BLOCK = Number.parseInt(arg('block', '0'), 10);
const MAX_DD = Number.parseFloat(arg('max-dd', '20'));
const RUIN = Number.parseFloat(arg('ruin', '50'));
const LEVERAGE = Number.parseFloat(arg('leverage', '1'));
const HORIZON = Number.parseInt(arg('horizon', '0'), 10);
const OUT = arg('out', 'data/monte-carlo-report.json');

function loadTrades(filePath: string): MonteCarloTrade[] {
  if (!exists(filePath)) {
    console.error(`ledger not found: ${filePath}`);
    console.error('Run the research plane (npm run self-improve) or a replay to populate it, or pass --ledger PATH.');
    process.exit(1);
  }
  const ledger = new SetupOutcomeLedger(filePath, { feeRate: 0.0004, slippageRate: 0.0002 });
  return ledger
    .all()
    .filter((r: SetupOutcomeRecord) => r.entryTouchedAt !== null && r.netR !== null)
    .map((r) => ({ netR: r.netR as number, t: r.createdAt, regime: r.features.regime }));
}

function exists(p: string): boolean {
  return existsSync(p);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function main(): void {
  const trades = loadTrades(LEDGER_PATH);
  if (trades.length === 0) {
    console.error('no resolved trades (entry touched + known outcome) in the ledger — nothing to simulate');
    process.exit(1);
  }

  const horizon = HORIZON > 0 ? HORIZON : undefined;
  const report = runMonteCarlo(trades, {
    simulations: SIMS,
    riskPerTradePct: RISK_PCT,
    seed: SEED,
    resample: MODE,
    ...(BLOCK > 0 ? { blockSize: BLOCK } : {}),
    maxDrawdownPct: MAX_DD,
    ruinLossPct: RUIN,
    leverage: LEVERAGE,
    ...(horizon !== undefined ? { horizonTrades: horizon } : {}),
  });

  const kelly = estimateKelly(
    trades.map((t) => ({ netR: t.netR, cluster: new Date(t.t).toISOString().slice(0, 10) }) satisfies KellySample),
    { iterations: 1000, seed: SEED },
  );

  console.log('=== Monte Carlo risk simulation ===');
  console.log(`trades: ${report.nTrades} | horizon: ${report.horizonTrades} | paths: ${report.config.simulations}`);
  console.log(`mode: ${report.config.resample} (block=${report.config.blockSize}) | risk/trade: ${pct(report.config.riskPerTradePct)} | leverage: ${report.config.leverage}x | seed: ${report.config.seed}`);
  for (const w of report.warnings) console.log(`warning: ${w}`);
  console.log('');
  console.log('--- Final outcome distribution ---');
  console.log(`final equity  p05 ${report.finalEquity.p05.toFixed(0)} | median ${report.finalEquity.median.toFixed(0)} | p95 ${report.finalEquity.p95.toFixed(0)} (start ${report.config.initialEquity.toFixed(0)})`);
  console.log(`final return  p05 ${report.finalReturnPct.p05.toFixed(1)}% | median ${report.finalReturnPct.median.toFixed(1)}% | p95 ${report.finalReturnPct.p95.toFixed(1)}%`);
  console.log(`P(end below start) = ${pct(report.probFinalBelowInitial)} ± ${pct(report.seFinalBelowInitial)}`);
  console.log('');
  console.log('--- Drawdown and ruin ---');
  console.log(`max drawdown  median ${report.maxDrawdownPct.median.toFixed(1)}% | p95 ${report.maxDrawdownPct.p95.toFixed(1)}% | p99 ${report.maxDrawdownPct.p99.toFixed(1)}%`);
  console.log(`P(breach ${report.config.maxDrawdownPct}% kill-switch) = ${pct(report.probDrawdownBreach)} ± ${pct(report.seDrawdownBreach)}`);
  console.log(`P(ruin at -${report.config.ruinLossPct}%) = ${pct(report.probRuin)} ± ${pct(report.seRuin)}`);
  console.log(`P(liquidation) = ${pct(report.probLiquidation)} ± ${pct(report.seLiquidation)} (${report.liquidationEvents} events)`);
  if (report.recoveryTrades) {
    console.log(`longest underwater stretch: median ${report.recoveryTrades.median.toFixed(0)} trades | p95 ${report.recoveryTrades.p95.toFixed(0)} trades`);
  }
  console.log('');
  console.log('--- Kelly sizing analysis (research-only) ---');
  console.log(`n=${kelly.n} | win rate ${(kelly.winRate * 100).toFixed(1)}% | mean ${kelly.meanNetR.toFixed(3)}R | payoff ${kelly.payoffRatio?.toFixed(2) ?? 'n/a'}`);
  console.log(`log-optimal Kelly ${pct(kelly.kellyLogOptimal)} (CI ${pct(kelly.ciLow)}–${pct(kelly.ciHigh)}) | binary reference ${pct(kelly.kellyBinary)}`);
  console.log(`half Kelly ${pct(kelly.halfKelly)} | quarter Kelly ${pct(kelly.quarterKelly)} | evidence: ${kelly.evidence}`);
  for (const w of kelly.warnings) console.log(`warning: ${w}`);

  const artifact = {
    generatedAt: new Date().toISOString(),
    monteCarlo: report,
    kelly,
  };
  try {
    mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    writeFileSync(path.resolve(OUT), JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`\nreport written to ${OUT}`);
  } catch (err) {
    console.error(`failed to write report artifact: ${(err as Error).message}`);
  }
}

main();
