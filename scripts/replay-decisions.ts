/**
 * Turns your rejected decisions into evidence. A rejected signal still carries entry/stop/target, so its bracket can be
 * walked over the real 5m price path that followed. This answers "were the strategies' ideas any good?" without waiting
 * for trades that the gates (rightly or wrongly) never allowed.
 *
 *   npx tsx scripts/replay-decisions.ts [--file data/decisions.jsonl] [--hold-hours 24] [--min-samples 15]
 *                                       [--fee 0.0004] [--slippage 0.0002] [--all-proposals] [--write]
 *
 * Needs outbound access to public Binance USD-M klines (no keys). Repeated proposals of one idea are collapsed
 * unless --all-proposals. Stop and target in the same 5m bar resolve against us. Treat output as a screen on a small sample.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { DecisionJournal, type DecisionRecord } from '../src/decision/DecisionJournal.js';
import { asHypotheticalExecuted, dedupeProposals, simulateBracket } from '../src/learning/HypotheticalOutcome.js';
import { calibrateRrFloors } from '../src/risk/rrProfile.js';
import type { Candle } from '../src/types.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const num = (name: string, fallback: number): number => {
  const v = Number(arg(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
};

const BASE = 'https://fapi.binance.com';
const INTERVAL_MS = 5 * 60_000;

async function fetchKlines(symbol: string, from: number, to: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let cursor = from; cursor < to;) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${to}&limit=1500`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`klines ${symbol} failed: HTTP ${response.status}`);
    const rows = (await response.json()) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) out.push({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) });
    cursor = Number(rows[rows.length - 1][0]) + INTERVAL_MS;
  }
  return out;
}

const file = path.resolve(arg('file', config.decisionsPath));
const holdMs = num('hold-hours', 24) * 3_600_000;
const feeRate = num('fee', config.risk.takerFeeRate);
const slippageRate = num('slippage', config.risk.slippageBufferRate);
const all = new DecisionJournal(file).all().filter((r) => r.side && r.entry !== null && r.stopLoss !== null && r.takeProfit !== null);
const ideas = process.argv.includes('--all-proposals') ? all : dedupeProposals(all);
console.log(`decisions with levels: ${all.length} · distinct ideas after collapsing repeats: ${ideas.length} · hold ≤ ${holdMs / 3_600_000}h`);

const bySymbol = new Map<string, DecisionRecord[]>();
for (const r of ideas) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r]);

const synthetic: DecisionRecord[] = [];
const tally = { TP: 0, SL: 0, TIMEOUT: 0, NO_DATA: 0 };
for (const [symbol, records] of bySymbol) {
  const from = Math.min(...records.map((r) => r.timestamp));
  const to = Math.min(Date.now(), Math.max(...records.map((r) => r.timestamp)) + holdMs + INTERVAL_MS);
  const candles = await fetchKlines(symbol, from, to);
  console.log(`  ${symbol}: ${candles.length} 5m candles for ${records.length} ideas`);
  for (const r of records) {
    const result = simulateBracket({ side: r.side!, entry: r.entry!, stopLoss: r.stopLoss!, takeProfit: r.takeProfit!, from: r.timestamp, maxHoldMs: holdMs }, candles);
    tally[result.outcome] += 1;
    const hypo = asHypotheticalExecuted(r, result);
    if (hypo) synthetic.push(hypo);
  }
}
console.log(`outcomes: TP ${tally.TP} · SL ${tally.SL} · timeout ${tally.TIMEOUT} · no data/invalid ${tally.NO_DATA}`);

const report = calibrateRrFloors(synthetic, { feeRate, slippageRate, minSamples: num('min-samples', 15) });
console.log('\nhypothetical, cost-adjusted, by strategy');
for (const v of report.verdicts) {
  if (v.status === 'CALIBRATED') console.log(`  ${v.strategy.padEnd(20)} CALIBRATED  minRr ${v.floor.minRr}  n=${v.floor.n}  netR ${v.floor.meanNetR.toFixed(3)}  lcb ${v.floor.lcbNetR.toFixed(3)}`);
  else console.log(`  ${v.strategy.padEnd(20)} ${v.status}  sample=${v.sample}${v.best ? `  best floor ${v.best.minRr}: n=${v.best.n} netR ${v.best.meanNetR.toFixed(3)} lcb ${v.best.lcbNetR.toFixed(3)}` : ''}`);
}
const perStrategy = new Map<string, number[]>();
for (const r of synthetic) {
  const risk = Math.abs(r.entry! - r.stopLoss!);
  const net = r.outcome!.rMultiple - (r.entry! * 2 * (feeRate + slippageRate)) / risk;
  perStrategy.set(r.strategy, [...(perStrategy.get(r.strategy) ?? []), net]);
}
console.log('\nunconditional net R per idea (no RR floor)');
for (const [strategy, rs] of [...perStrategy].sort()) {
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  console.log(`  ${strategy.padEnd(20)} n=${String(rs.length).padStart(3)}  mean ${mean.toFixed(3)}R  win ${((rs.filter((x) => x > 0).length / rs.length) * 100).toFixed(0)}%`);
}
console.log('\nSmall sample, hypothetical fills at the quoted entry, intrabar ties resolved against us: a screen, not proof.');

if (process.argv.includes('--write')) {
  const out = path.resolve(arg('out', 'data/rr-profile.json'));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report.profile, null, 2));
  console.log(`wrote ${out}`);
}
