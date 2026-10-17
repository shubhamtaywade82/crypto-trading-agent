import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import type { SMCFrame } from '../src/strategies/smc-ml/types.js';
import {
  DEFAULT_ADMISSION_POLICY, DEFAULT_OUTCOME_POLICY, fetchSdkCandles, FRAME_MS, PlaybookJournal, replayPlaybooks, walkForward,
  type CalibrationSample, type KlineSource, type PlaybookVerdict,
} from '../src/playbooks/index.js';

const DAY = 24 * 60 * 60_000;
const T = 118_056 * 4 * 60 * 60_000; // a multiple of 4h
const EXECUTION = { spreadBps: 1, takerFeeRate: 0.0004, slippageRate: 0.0002 };
const journalFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'playbook-replay-')), 'journal.jsonl');

test('SDK candles: paginated, sorted, de-duplicated, forming bar dropped', async () => {
  const all = Array.from({ length: 3200 }, (_, i) => ({ openTime: T + i * FRAME_MS['5m'], open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }));
  const calls: number[] = [];
  const source: KlineSource = {
    klines: async (_symbol, _frame, { startTime = 0, endTime = Infinity, limit = 1500 }) => {
      calls.push(startTime);
      return all.filter((k) => k.openTime >= startTime && k.openTime <= endTime).slice(0, limit);
    },
  };
  const end = T + 3200 * FRAME_MS['5m'];
  const now = end - 1; // the last bar is still forming
  const candles = await fetchSdkCandles(source, 'SOLUSDT', '5m', T, end, now);

  assert.equal(candles.length, 3199);
  assert.equal(calls.length, 3);
  assert.ok(candles.every((c, i) => i === 0 || c.openTime - candles[i - 1].openTime === FRAME_MS['5m']));
});

test('SDK candles: a page that does not advance is an error, not an endless loop', async () => {
  const stuck: KlineSource = { klines: async () => [{ openTime: T - FRAME_MS['5m'], open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }] };
  await assert.rejects(fetchSdkCandles(stuck, 'SOLUSDT', '5m', T, T + DAY, T + 2 * DAY), /did not advance/);
});

/** Deterministic random walk ending at `end`, `count` bars, with trending stretches so structure forms. */
function walk(frame: SMCFrame, count: number, end: number, seed: number): Candle[] {
  let state = seed;
  const rand = () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; };
  let price = 150;
  return Array.from({ length: count }, (_, i) => {
    const drift = Math.sin(i / 40) * 0.002;
    const open = price;
    const close = open * (1 + drift + (rand() - 0.5) * 0.012);
    price = close;
    const wick = open * rand() * 0.003;
    return { openTime: end - (count - i) * FRAME_MS[frame], open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 50 + rand() * 200 };
  });
}

function history(end: number) {
  return { '5m': walk('5m', 2600, end, 1), '15m': walk('15m', 900, end, 2), '1h': walk('1h', 400, end, 3), '4h': walk('4h', 400, end, 4) };
}

test('replay: steps every 5m close, records decisions only at their own trigger close, and is idempotent', () => {
  const end = T + 10 * DAY;
  const candles = history(end);
  const from = end - 3 * DAY;
  const to = end - DAY;
  const file = journalFile();
  const seen: PlaybookVerdict[] = [];
  const summary = replayPlaybooks({ symbol: 'SOLUSDT', candles, from, to, execution: EXECUTION, journal: new PlaybookJournal(file), outcomePolicy: DEFAULT_OUTCOME_POLICY, onVerdict: (v) => seen.push(v) });

  assert.equal(summary.steps, 2 * DAY / FRAME_MS['5m'] + 1);
  assert.equal(seen.length, summary.steps * 6);
  assert.equal(summary.verdicts.ENTRY_ELIGIBLE + summary.verdicts.WATCH + summary.verdicts.NO_TRADE, seen.length);
  const journal = new PlaybookJournal(file);
  for (const d of journal.decisions()) {
    assert.ok(d.decidedAt >= from && d.decidedAt <= to);
    assert.equal(d.decidedAt % FRAME_MS['5m'], 0);
  }
  for (const s of journal.samples()) assert.ok(s.resolvedAt >= s.decidedAt);

  const again = replayPlaybooks({ symbol: 'SOLUSDT', candles, from, to, execution: EXECUTION, journal, outcomePolicy: DEFAULT_OUTCOME_POLICY });
  assert.equal(again.decisionsRecorded, 0);
  assert.equal(again.outcomesWritten, 0);
});

test('replay is causal: changing every bar after X changes no verdict at or before X', () => {
  const end = T + 10 * DAY;
  const from = end - 3 * DAY;
  const cut = end - 2 * DAY;
  const original = history(end);
  const altered = Object.fromEntries(Object.entries(original).map(([frame, bars]) => [frame, bars.map((c) => {
    if (c.openTime + FRAME_MS[frame as SMCFrame] <= cut) return c;
    // A different future: prices shifted and the shape inverted
    return { ...c, open: 300 - c.open, close: 300 - c.close, high: 300 - c.low, low: 300 - c.high };
  })]));
  const run = (candles: Record<string, Candle[]>) => {
    const out: string[] = [];
    replayPlaybooks({
      symbol: 'SOLUSDT', candles, from, to: cut, execution: EXECUTION, journal: new PlaybookJournal(journalFile()), outcomePolicy: DEFAULT_OUTCOME_POLICY,
      onVerdict: (v) => out.push(JSON.stringify([v.evaluatedAt, v.playbookId, v.direction, v.verdict, v.evaluations])),
    });
    return out;
  };
  assert.deepEqual(run(altered), run(original));
});

test('replay refuses a series with a gap instead of reading structure across it', () => {
  const candles = history(T + 10 * DAY);
  candles['15m'].splice(400, 1);
  assert.throws(() => replayPlaybooks({ symbol: 'SOLUSDT', candles, from: T + 7 * DAY, to: T + 8 * DAY, execution: EXECUTION, journal: new PlaybookJournal(journalFile()), outcomePolicy: DEFAULT_OUTCOME_POLICY }), /gap in 15m bars/);
});

test('walk-forward: buckets are admitted from earlier folds only and judged on the next', () => {
  // 120 days, 10 setups a day: G wins half its trades at +2 R, B a fifth
  const samples: CalibrationSample[] = [];
  for (let i = 0; i < 1200; i += 1) {
    const bucket = i % 2 === 0 ? 'G' : 'B';
    const k = Math.floor(i / 2);
    const win = bucket === 'G' ? k % 2 === 0 : k % 5 === 0;
    const decidedAt = T + Math.floor(i / 10) * DAY + (i % 10) * 60 * 60_000;
    samples.push({ setupId: `s${i}`, bucket, decidedAt, resolvedAt: decidedAt + 30 * 60_000, label: win ? 'TARGET' : 'STOP', netR: win ? 2 : -1 });
  }
  const report = walkForward(samples, { folds: 4, policy: DEFAULT_ADMISSION_POLICY });

  assert.equal(report.folds.length, 3);
  assert.deepEqual(report.folds[0].admittedBuckets, [], '150 G outcomes before fold 1: below the 200 minimum');
  assert.deepEqual(report.folds[1].admittedBuckets, ['G']);
  assert.deepEqual(report.folds[2].admittedBuckets, ['G']);
  for (const f of report.folds.slice(1)) assert.ok(f.evAdmitted! > f.evAll!);
  assert.ok(report.admittedOutOfSample.lowerBound! > 0);
});
