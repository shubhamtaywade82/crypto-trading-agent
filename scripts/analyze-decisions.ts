/**
 * Where do decisions go and what do the candidates look like? Works on rejected signals too, which calibrate-rr cannot
 * (they have no outcome), so it is the tool for "why is nothing trading" and "how bad is the RR geometry".
 *
 * Run locally:  npx tsx scripts/analyze-decisions.ts [--file data/decisions.jsonl]
 */
import path from 'node:path';
import { config } from '../src/config.js';
import { DecisionJournal, type DecisionRecord } from '../src/decision/DecisionJournal.js';
import { classifyRiskRefusal } from '../src/decision/NoTrade.js';

const i = process.argv.indexOf('--file');
const file = path.resolve(i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : config.decisionsPath);
const records = new DecisionJournal(file).all();

const count = <T>(items: T[], key: (t: T) => string): [string, number][] => {
  const m = new Map<string, number>();
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const plannedRr = (r: DecisionRecord): number | null => {
  if (r.entry === null || r.stopLoss === null || r.takeProfit === null) return null;
  const risk = Math.abs(r.entry - r.stopLoss);
  return risk > 0 ? Math.abs(r.takeProfit - r.entry) / risk : null;
};
const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const line = (k: string, n: number, total: number): void => console.log(`  ${k.padEnd(34)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(0).padStart(3)}%`);

console.log(`decisions: ${records.length} · file: ${file}`);
if (records.length === 0) process.exit(0);
const span = (records.at(-1)!.timestamp - records[0].timestamp) / 3_600_000;
console.log(`span: ${span.toFixed(1)}h · first ${new Date(records[0].timestamp).toISOString()} · last ${new Date(records.at(-1)!.timestamp).toISOString()}`);

console.log('\nstatus');
for (const [k, n] of count(records, (r) => r.status)) line(k, n, records.length);

const rejected = records.filter((r) => r.status === 'RISK_REJECTED');
console.log('\nrisk refusals by cause');
for (const [k, n] of count(rejected, (r) => classifyRiskRefusal(r.rejectionReason ?? ''))) line(k, n, rejected.length);

console.log('\nplanned RR by strategy (all decisions, rejected included)');
for (const [strategy] of count(records, (r) => r.strategy)) {
  const rrs = records.filter((r) => r.strategy === strategy).map(plannedRr).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (rrs.length === 0) continue;
  const below = (t: number): string => `${((rrs.filter((v) => v < t).length / rrs.length) * 100).toFixed(0)}%`;
  console.log(`  ${strategy.padEnd(20)} n=${String(rrs.length).padStart(3)}  p10 ${quantile(rrs, 0.1).toFixed(2)}  median ${quantile(rrs, 0.5).toFixed(2)}  p90 ${quantile(rrs, 0.9).toFixed(2)}  <0.25: ${below(0.25)}  <1.0: ${below(1)}`);
}

// The same idea re-proposed again and again: same symbol + strategy + side within 60 minutes of the previous one
const last = new Map<string, number>();
let repeats = 0;
for (const r of records) {
  const k = `${r.symbol}:${r.strategy}:${r.side}`;
  if (r.timestamp - (last.get(k) ?? -Infinity) < 3_600_000) repeats += 1;
  last.set(k, r.timestamp);
}
console.log(`\nre-proposals within 60m of the same symbol/strategy/side: ${repeats} of ${records.length} (${((repeats / records.length) * 100).toFixed(0)}%)`);

const executed = records.filter((r) => r.status === 'EXECUTED');
const closed = executed.filter((r) => r.outcome);
console.log(`\nexecuted: ${executed.length} · with outcome: ${closed.length}`);
for (const r of closed) console.log(`  ${r.symbol} ${r.strategy} ${r.side} plannedRR ${plannedRr(r)?.toFixed(2)} → ${r.outcome!.rMultiple}R (${r.outcome!.reason})`);
