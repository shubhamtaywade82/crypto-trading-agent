/**
 * Calibration report for the playbook journal: per bucket, the TP-before-SL estimate known now and whether the gate
 * would admit it, then the prequential (out-of-sample) calibration of the bucket rates.
 *
 *   npx tsx scripts/playbook-calibration.ts [journal.jsonl]     default data/playbook-journal.jsonl
 */
import { admit, estimateOutcome, PlaybookJournal, prequentialCalibration } from '../src/playbooks/index.js';

const file = process.argv[2] ?? 'data/playbook-journal.jsonl';
const journal = new PlaybookJournal(file);
const samples = journal.samples();
const now = Date.now();
const fmt = (x: number | null, digits = 3) => (x === null ? 'n/a' : x.toFixed(digits));

console.log(`${file}: ${journal.decisions().length} decisions, ${samples.length} resolved, ${journal.pending().length} pending, ${journal.skippedLines} unreadable lines`);
for (const bucket of [...new Set(samples.map((s) => s.bucket))].sort()) {
  const e = estimateOutcome(samples, bucket, now);
  const a = admit(e);
  console.log([
    bucket.padEnd(40),
    `n=${e.n} days=${e.clusters} fill=${fmt(e.fillRate, 2)}`,
    `pTP=${fmt(e.pTarget)} [${fmt(e.pTargetLow)}, ${fmt(e.pTargetHigh)}] pSL=${fmt(e.pStop)} pTO=${fmt(e.pTimeout)}`,
    `E[R]=${fmt(e.evR)} LB=${fmt(e.evLowerBoundR)}`,
    a.admitted ? 'ADMITTED' : `${a.reason}: ${a.detail}`,
  ].join('  '));
}
const report = prequentialCalibration(samples);
console.log(`prequential TP calibration: scored ${report.n}, Brier ${fmt(report.brier, 4)} vs pooled ${fmt(report.brierPooled, 4)} (lower is better; the bucket rate adds information only if it beats pooled)`);
for (const bin of report.bins.filter((b) => b.n > 0)) {
  console.log(`  predicted ${bin.low.toFixed(1)}-${bin.high.toFixed(1)}: n=${bin.n} mean predicted ${fmt(bin.meanPredicted)} observed ${fmt(bin.observedRate)}`);
}
