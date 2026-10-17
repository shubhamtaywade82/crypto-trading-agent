/**
 * Replays the SMC playbooks over history, fills a playbook journal with every decision they would have taken and its
 * outcome, then reports per-bucket calibration and a walk-forward test of the calibration gate.
 *
 *   npx tsx scripts/playbook-replay.ts --symbol SOLUSDT --days 30 [--end-days-ago 1] [--source archive|sdk]
 *                                      [--spread-bps 1] [--folds 4] [--journal data/playbook-replay-SOLUSDT.jsonl]
 *
 * archive = data.binance.vision (lags about a day; works where fapi.binance.com answers HTTP 451)
 * sdk     = @nemesis-oss/binance-sdk, read-only client with its clock synced
 *
 * Kline data has no spread: --spread-bps is an assumption, printed with the results.
 */
import { fetchArchiveKlines } from '../src/backtesting/archiveKlines.js';
import type { Candle } from '../src/types.js';
import type { SMCFrame } from '../src/strategies/smc-ml/types.js';
import {
  admit, createReadOnlyMarketClient, DEFAULT_OUTCOME_POLICY, estimateOutcome, fetchSdkCandles, FRAME_MS, PlaybookJournal,
  prequentialCalibration, replayPlaybooks, sdkKlineSource, walkForward,
} from '../src/playbooks/index.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const DAY = 24 * 60 * 60_000;
const symbol = arg('symbol', 'SOLUSDT').toUpperCase();
const days = Number(arg('days', '30'));
const endDaysAgo = Number(arg('end-days-ago', '1'));
const source = arg('source', 'archive');
const spreadBps = Number(arg('spread-bps', '1'));
const folds = Number(arg('folds', '4'));
const journalPath = arg('journal', `data/playbook-replay-${symbol}.jsonl`);
const WINDOW = 300;
const FRAMES: SMCFrame[] = ['5m', '15m', '1h', '4h'];
if (!['archive', 'sdk'].includes(source)) throw new Error('--source must be archive or sdk');
if (!(days > 0) || !(spreadBps >= 0)) throw new Error('--days must be > 0 and --spread-bps >= 0');

const to = Math.floor(Date.now() / DAY) * DAY - endDaysAgo * DAY;
const from = to - days * DAY;
const policy = DEFAULT_OUTCOME_POLICY;
const fmt = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? 'n/a' : x.toFixed(d));

async function load(): Promise<Partial<Record<SMCFrame, Candle[]>>> {
  const client = source === 'sdk' ? sdkKlineSource(await createReadOnlyMarketClient([symbol])) : null;
  const out: Partial<Record<SMCFrame, Candle[]>> = {};
  for (const frame of FRAMES) {
    const fetchFrom = from - WINDOW * FRAME_MS[frame];
    // 5m also covers the outcome horizon after the last decision
    const fetchTo = frame === '5m' ? to + (policy.horizonBars + 1) * FRAME_MS['5m'] : to;
    if (client) {
      out[frame] = await fetchSdkCandles(client, symbol, frame, fetchFrom, fetchTo);
    } else {
      const archive = await fetchArchiveKlines(symbol, frame, fetchFrom, fetchTo);
      if (archive.missingDays.length) console.log(`  ${frame}: archive has no file for ${archive.missingDays.join(', ')}`);
      out[frame] = archive.candles;
    }
    console.log(`  ${frame}: ${out[frame]!.length} bars`);
  }
  return out;
}

console.log(`Playbook replay ${symbol}: ${new Date(from).toISOString()} to ${new Date(to).toISOString()} from ${source}; assumed spread ${spreadBps} bps`);
const candles = await load();
const journal = new PlaybookJournal(journalPath);
const started = Date.now();
const summary = replayPlaybooks({
  symbol, candles, from, to, journal, outcomePolicy: policy,
  execution: { spreadBps, takerFeeRate: policy.takerFeeRate, slippageRate: policy.slippageRate },
  onProgress: (done, total) => { if (done % 2000 === 0 || done === total) process.stdout.write(`\r  step ${done}/${total}`); },
});
console.log(`\n  ${summary.steps} steps in ${((Date.now() - started) / 1000).toFixed(1)} s; verdicts ${JSON.stringify(summary.verdicts)}; warm-up steps ${summary.warmupSteps}`);
console.log(`  ${summary.decisionsRecorded} new decisions, ${summary.outcomesWritten} outcomes written, ${summary.pendingAfter} pending; journal ${journalPath}`);

const samples = journal.samples().filter((s) => s.setupId.includes(`:${symbol}:`));
for (const bucket of [...new Set(samples.map((s) => s.bucket))].sort()) {
  const e = estimateOutcome(samples, bucket, Number.MAX_SAFE_INTEGER);
  const a = admit(e);
  console.log(`  ${bucket.padEnd(36)} n=${e.n} days=${e.clusters} fill=${fmt(e.fillRate, 2)} pTP=${fmt(e.pTarget)} pSL=${fmt(e.pStop)} pTO=${fmt(e.pTimeout)} E[R]=${fmt(e.evR)} LB=${fmt(e.evLowerBoundR)} ${a.admitted ? 'ADMITTED' : a.reason}`);
}
const report = prequentialCalibration(samples);
console.log(`  prequential: scored ${report.n}, Brier ${fmt(report.brier, 4)} vs pooled ${fmt(report.brierPooled, 4)}`);
const wf = walkForward(samples, { folds });
for (const f of wf.folds) {
  console.log(`  fold ${f.index}: ${new Date(f.start).toISOString().slice(0, 10)}..${new Date(f.end).toISOString().slice(0, 10)} n=${f.n} E[R]=${fmt(f.evAll)} admitted=${f.admittedBuckets.length} nAdmitted=${f.nAdmitted} E[R]admitted=${fmt(f.evAdmitted)}`);
}
console.log(`  walk-forward admitted out of sample: n=${wf.admittedOutOfSample.n} E[R]=${fmt(wf.admittedOutOfSample.mean)} LB=${fmt(wf.admittedOutOfSample.lowerBound)}`);
