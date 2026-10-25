import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import {
  DEFAULT_EVAL_CONFIG, evaluate, labelSegment, parseReading, renderReport, roundTripCostBps, segmentReadings, type EvalConfig, type RecordedReading,
} from '../src/microstructure/MicroEval.js';

const T0 = Date.UTC(2026, 9, 26, 0, 0);
const cfg: EvalConfig = { ...DEFAULT_EVAL_CONFIG, iterations: 400 };

const reading = (t: number, mid: number | null, o: Partial<RecordedReading> = {}): RecordedReading => ({
  symbol: 'SOLUSDT', t, book: { status: 'LIVE' }, mid, spreadBps: 1, friction: { status: 'OK', buySlipBps: 0.5, sellSlipBps: 0.5 }, bias: { bias: 'NEUTRAL' }, ...o,
});

// ---- parsing, integrity, labelling -------------------------------------------------------------------------------

test('parses recorded lines and rejects anything that is not a usable reading', () => {
  const ok = parseReading(JSON.stringify({ ...reading(T0, 100), events: [{ kind: 'WALL' }], flow: { cvd: 5 }, windows: [{ ms: 5000, phase: 'BALANCED', ofi: 'x', trades: 9 }] }));
  assert.equal(ok?.mid, 100);
  // Only evaluated fields survive parsing; a non-numeric OFI becomes null rather than a string
  assert.deepEqual(Object.keys(ok!).sort(), ['bias', 'book', 'friction', 'mid', 'spreadBps', 'symbol', 't', 'windows']);
  assert.deepEqual(ok!.windows, [{ ms: 5000, phase: 'BALANCED', ofi: null }]);
  assert.equal(parseReading('{"symbol":"SOLUSDT","t":1,"book":{"status":"SYNCING"},"mid":null}')?.mid, null);
  for (const bad of ['', 'not json', '{"t":1}', '{"symbol":"X","t":"1","book":{"status":"LIVE"}}', '{"symbol":"X","t":1,"book":{"status":"LIVE"},"mid":-5}']) {
    assert.equal(parseReading(bad), null, bad);
  }
});

test('integrity: duplicates and disorder are counted, gaps and non-live readings split segments', () => {
  const rs = [
    reading(T0 + 1_000, 100), reading(T0, 100), reading(T0 + 1_000, 100), // out of order + duplicate
    reading(T0 + 2_000, 100), reading(T0 + 3_000, null, { book: { status: 'STALE' } }), reading(T0 + 4_000, 100),
    reading(T0 + 20_000, 100), reading(T0 + 21_000, 100),
  ];
  const { segments, integrity } = segmentReadings('SOLUSDT', rs, 2, 3_000);
  assert.deepEqual(segments.map((s) => s.map((r) => (r.t - T0) / 1000)), [[0, 1, 2], [4], [20, 21]]);
  assert.deepEqual(
    [integrity.lines, integrity.malformed, integrity.duplicates, integrity.outOfOrder, integrity.live, integrity.gaps, integrity.longestGapMs, integrity.statuses],
    [10, 2, 1, 1, 6, 1, 16_000, { LIVE: 6, STALE: 1 }],
  );
});

test('labels use the first mid at or after t + horizon, within tolerance and inside the segment only', () => {
  const seg = [0, 1, 2, 3, 5, 6].map((s) => reading(T0 + s * 1_000, 100 + s * 0.01, { bias: { bias: s >= 3 ? 'LONG' : 'NEUTRAL' } }));
  const out = labelSegment(seg, { ...cfg, horizonsMs: [1_000, 2_000, 10_000], toleranceMs: 1_500 }, T0 + 4_000);
  assert.ok(Math.abs(out[0].forwardBps[0]! - 1) < 1e-9); // 100 -> 100.01
  assert.ok(Math.abs(out[3].forwardBps[0]! - (0.02 / 100.03) * 10_000) < 1e-9); // t=3 -> first mid at/after 4 s is t=5
  assert.equal(out[0].forwardBps[2], null); // nothing 10 s ahead in this segment
  assert.deepEqual(out.map((l) => l.biasOnset), [false, false, false, true, false, false]);
  assert.deepEqual(out.map((l) => l.split), ['train', 'train', 'train', 'train', 'holdout', 'holdout']);

  const thinned = labelSegment(seg, { ...cfg, horizonsMs: [1_000], strideMs: 5_000 }, T0);
  assert.deepEqual(thinned.map((l) => (l.r.t - T0) / 1000), [0, 3, 5]); // 3 survives because it is a bias onset
});

test('round-trip cost is measured slippage when recorded, else the spread, plus two fees', () => {
  assert.equal(roundTripCostBps(reading(T0, 100), 4), 9);
  assert.equal(roundTripCostBps(reading(T0, 100, { friction: { status: 'BLOCK', buySlipBps: null, sellSlipBps: 2 } }), 4), 9);
  assert.equal(roundTripCostBps(reading(T0, 100, { friction: undefined, spreadBps: null }), 4), null);
});

// ---- evaluation on synthetic recordings ---------------------------------------------------------------------------

/**
 * Six hours per symbol at 1 Hz. Every 10 minutes a 2-minute episode: the bias reads LONG and the 30s phase reads
 * initiative buying while the mid climbs `edgeBpsPerSec`. The rest is a seeded random walk with NEUTRAL bias. OFI is noise.
 */
function synthetic(symbol: string, seed: number, edgeBpsPerSec: number, hours = 6): RecordedReading[] {
  const rand = mulberry32(seed);
  const out: RecordedReading[] = [];
  let mid = 100;
  for (let s = 0; s < hours * 3_600; s += 1) {
    const inEpisode = s % 600 >= 60 && s % 600 < 180;
    mid *= 1 + ((rand() - 0.5) * 1 + (inEpisode ? edgeBpsPerSec : 0)) / 10_000;
    out.push({
      symbol, t: T0 + s * 1_000, book: { status: 'LIVE' }, mid, spreadBps: 1,
      friction: { status: 'OK', buySlipBps: 0.5, sellSlipBps: 0.5 },
      bias: { bias: inEpisode ? 'LONG' : 'NEUTRAL' },
      evidence: inEpisode ? 'SUPPORTS_LONG' : 'NONE',
      phase: inEpisode ? 'INITIATIVE_BUYING' : 'BALANCED',
      windows: [{ ms: 30_000, phase: inEpisode ? 'INITIATIVE_BUYING' : 'BALANCED', ofi: (rand() - 0.5) * 4, complete: true }],
    });
  }
  return out;
}

const find = (res: ReturnType<typeof evaluate>, condition: string, horizonMs: number) => res.directional.find((d) => d.condition === condition && d.horizonMs === horizonMs)!;

test('finds a planted edge net of costs in both splits, and fails the noise', () => {
  const res = evaluate([{ symbol: 'SOLUSDT', readings: synthetic('SOLUSDT', 7, 1), malformed: 0 }, { symbol: 'ETHUSDT', readings: synthetic('ETHUSDT', 8, 1), malformed: 0 }], cfg);
  const long30 = find(res, 'bias LONG', 30_000);
  assert.equal(long30.verdict, 'PASS');
  assert.ok(long30.holmRejected);
  assert.ok(long30.holdout.summary!.mean > 15, String(long30.holdout.summary!.mean)); // ~30 bp drift - 9 bp cost
  assert.ok(Math.abs(long30.holdout.grossMean! - long30.holdout.summary!.mean - 9) < 1e-6);
  assert.equal(find(res, '30s INITIATIVE_BUYING', 30_000).verdict, 'PASS');

  // OFI is pure noise: its extreme quintiles cannot pay a 9 bp round trip
  for (const q of ['30s OFI Q5', '30s OFI Q1']) assert.equal(find(res, q, 30_000).verdict, 'FAIL', q);
  // Never observed: no data, no verdict
  assert.equal(find(res, 'bias SHORT', 30_000).verdict, 'INSUFFICIENT');
  assert.ok(res.ofiQuintiles[30_000].length === 4);
  assert.deepEqual(res.integrity.map((i) => [i.symbol, i.segments, i.gaps]), [['SOLUSDT', 1, 0], ['ETHUSDT', 1, 0]]);
  assert.ok(res.volThresholds !== null);
});

test('a real but small move that costs eat is a FAIL, with a positive gross mean on show', () => {
  const res = evaluate([{ symbol: 'SOLUSDT', readings: synthetic('SOLUSDT', 3, 0.15), malformed: 0 }, { symbol: 'ETHUSDT', readings: synthetic('ETHUSDT', 4, 0.15), malformed: 0 }], cfg);
  const cell = find(res, 'bias LONG', 30_000);
  assert.equal(cell.verdict, 'FAIL');
  assert.ok(cell.holdout.grossMean! > 2); // ~4.5 bp of real drift
  assert.ok(cell.holdout.summary!.mean < 0); // after 9 bp of costs
});

test('the evaluation is reproducible from its seed and the report names every section', () => {
  // Six hours: the holdout (last 30%) then spans more than the 5 fifteen-minute clusters a verdict needs
  const input = [{ symbol: 'SOLUSDT', readings: synthetic('SOLUSDT', 7, 1, 6), malformed: 1 }];
  const a = evaluate(input, cfg);
  const b = evaluate(input, cfg);
  assert.deepEqual(JSON.stringify(a.directional), JSON.stringify(b.directional));
  const md = renderReport(a);
  for (const section of ['# Microstructure evaluation', '## Recording integrity', '## Label coverage', '## Directional conditions', '## Holdout by volatility regime', '## Baselines', '## Round-trip cost by friction status', '## Caveats']) {
    assert.ok(md.includes(section), section);
  }
  assert.match(md, /\| bias LONG \| long \| 30s \| .* \| PASS/);
  assert.match(md, /\| SOLUSDT \| 21601 \| 1 \|/);

  const none = evaluate([{ symbol: 'SOLUSDT', readings: [reading(T0, null, { book: { status: 'SYNCING' } })], malformed: 0 }], cfg);
  assert.deepEqual([none.labelled, none.directional.length, none.splitAt], [0, 0, null]);
  assert.match(renderReport(none), /Microstructure evaluation/);
});

// ---- CLI ---------------------------------------------------------------------------------------------------------

test('the CLI reads a recording directory and writes REPORT.md and results.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'micro-eval-'));
  const rec = path.join(dir, 'rec');
  const readings = synthetic('SOLUSDT', 11, 1, 2);
  const byDay = new Map<string, string[]>();
  for (const r of readings) {
    const day = new Date(r.t).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(r)]);
  }
  for (const [day, lines] of byDay) {
    mkdirSync(path.join(rec, day), { recursive: true });
    writeFileSync(path.join(rec, day, 'SOLUSDT.jsonl'), `${lines.join('\n')}\n{broken\n`);
  }
  const out = path.join(dir, 'out');
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/micro-eval.ts', '--dir', rec, '--out', out, '--iterations', '200', '--horizons', '5,30'], { encoding: 'utf-8', cwd: process.cwd() });
  assert.equal(run.status, 0, run.stderr);
  const md = readFileSync(path.join(out, 'REPORT.md'), 'utf-8');
  assert.match(md, /Horizons 5s, 30s/);
  assert.match(md, /\| SOLUSDT \| 7201 \| 1 \|/);
  const json = JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf-8'));
  assert.deepEqual(json.days, ['2026-10-26']);

  const missing = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/micro-eval.ts', '--dir', path.join(dir, 'nope')], { encoding: 'utf-8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist: record with MICRO_RECORD=on first/);
});

test('too little holdout to cluster is INSUFFICIENT, never a verdict', () => {
  // Three hours of one symbol: the holdout is ~54 minutes, fewer than 5 fifteen-minute clusters
  const res = evaluate([{ symbol: 'SOLUSDT', readings: synthetic('SOLUSDT', 7, 1, 3), malformed: 0 }], cfg);
  const cell = find(res, 'bias LONG', 30_000);
  assert.equal(cell.verdict, 'INSUFFICIENT');
  assert.ok(cell.holdout.summary!.clusters < 5);
  assert.ok(cell.holdout.summary!.mean > 0); // the edge is there; the evidence is not enough to say so
});

test('it parses exactly what the live recorder writes', async () => {
  const { MicrostructureFeed, microConfigFromEnv } = await import('../src/microstructure/MicrostructureFeed.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'micro-rec-'));
  let now = T0;
  const handles = new Map<string, { listeners: Record<string, Array<(x: any) => void>> }>();
  const source = {
    subscribe: async (stream: string) => {
      const h = { listeners: {} as Record<string, Array<(x: any) => void>>, on(e: string, l: (x: any) => void) { (this.listeners[e] ??= []).push(l); return this; }, close() {} };
      handles.set(stream, h);
      return h as any;
    },
    depthSnapshot: async () => ({ lastUpdateId: 10, bids: [{ price: 100, qty: 50 }, { price: 99.99, qty: 50 }], asks: [{ price: 100.02, qty: 50 }, { price: 100.03, qty: 50 }] }),
  };
  const feed = new MicrostructureFeed(['SOLUSDT'], { source, config: { ...microConfigFromEnv({}), record: true, recordDir: dir }, log: () => {}, now: () => now, snapshotDelayMs: 1 });
  await feed.start();
  feed.stop();
  (feed as any).stopped = false;
  const emit = (stream: string, payload: unknown) => { for (const l of handles.get(stream)!.listeners.message ?? []) l(payload); };
  emit('solusdt@depth@100ms', { U: 9, u: 11, pu: 8, E: now, b: [], a: [] });
  await new Promise((r) => setTimeout(r, 20));
  for (let s = 1, u = 11; s <= 90; s += 1, u += 1) {
    now = T0 + s * 1_000;
    emit('solusdt@depth@100ms', { U: u + 1, u: u + 1, pu: u, E: now, b: [['100', String(50 + s)]], a: [] });
    emit('solusdt@aggTrade', { T: now - 5, p: 100.02, q: 1, m: false });
    feed.sampleAll();
  }
  (feed as any).stopped = true;
  const lines = readFileSync(path.join(dir, '2026-10-26', 'SOLUSDT.jsonl'), 'utf-8').trim().split('\n');
  const parsed = lines.map(parseReading);
  assert.equal(parsed.filter((r) => r === null).length, 0);
  assert.equal(parsed.length, 90);
  const live = parsed.filter((r) => r!.book.status === 'LIVE');
  assert.equal(live.length, 90);
  assert.deepEqual(live[89]!.windows!.map((w) => w.ms), [5_000, 30_000, 120_000, 300_000]);
  assert.ok(live[89]!.windows![1].ofi! > 0); // the bid queue grew every second
  assert.equal(live[89]!.bias!.bias, 'NEUTRAL');
  const res = evaluate([{ symbol: 'SOLUSDT', readings: parsed as RecordedReading[], malformed: 0 }], { ...cfg, minN: 5, minClusters: 1 });
  assert.equal(res.integrity[0].segments, 1);
  assert.equal(res.coverage.find((c) => c.horizonMs === 30_000)!.labelled, 60);
  assert.ok(res.costs[0].p50! > 8); // spread 2 bp + two 4 bp fees
});
