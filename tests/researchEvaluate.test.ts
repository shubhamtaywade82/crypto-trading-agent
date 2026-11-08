import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { wilderAtr } from '../src/binance/indicators.js';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { contextFlags, evaluateSpec, simulateLong, type SeriesInput, type SimInput } from '../src/research/pipeline/evaluate.js';
import { parseSpec, specHash, type HypothesisSpec } from '../src/research/pipeline/hypothesis.js';
import type { Candle } from '../src/types.js';

const HOUR_MS = 3_600_000;
const FLAT_BARS = 260;
const PARAMS = { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 };

/** Random walk; with `plantedEdge`, every close above the 20-bar high is followed by three bars of +1.5% drift. */
function walk(bars: number, seed: number, plantedEdge: boolean): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];
  let boost = 0;
  let close = 100;
  for (let i = 0; i < bars; i += 1) {
    const open = close;
    close = open * (1 + (rand() + rand() + rand() - 1.5) * 0.02 + (boost > 0 ? 0.015 : 0));
    boost = Math.max(0, boost - 1);
    candles.push({ openTime: i * HOUR_MS, open, high: Math.max(open, close) * (1 + 0.004 * rand()), low: Math.min(open, close) * (1 - 0.004 * rand()), close, volume: 1 });
    const priorHigh = Math.max(...candles.slice(Math.max(0, i - 20), i).map((c) => c.high));
    if (plantedEdge && i >= 20 && close > priorHigh) boost = 3;
  }
  return candles;
}

/** Bars from `from` on get wider ranges (and a lower close), keeping each bar's open: valid OHLC, different future. */
const perturbFrom = (candles: Candle[], from: number): Candle[] =>
  candles.map((c, i) => (i < from ? c : { ...c, high: c.high * 4, low: c.low * 0.2, close: c.close * 0.5 }));

const spec = (over: Record<string, unknown> = {}): HypothesisSpec => parseSpec({
  schemaVersion: 1, id: 'EVAL-TEST', version: 1, status: 'REGISTERED', hypothesis: 'evaluation stage fixture', family: 'DONCHIAN_BREAKOUT',
  symbols: ['SOLUSDT'], timeframes: ['1h'], timeframeRule: 'each timeframe independently',
  context: { id: 'EMA50_GT_EMA200_ATR14_Q33_TRAIN', taxonomyVersion: 'ctx-v1' }, params: PARAMS,
  window: { days: 500, endDaysAgo: 0, endIso: '2026-10-01T00:00:00.000Z', split: { trainPct: 60, validationPct: 20, testPct: 20 } },
  costs: { roundTripBps: 5 }, evidence: { minOosTrades: 10, alpha: 0.05 }, ...over,
}, 'test');

function withLedger<T>(run: (ledgerFile: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'oos-'));
  try { return run(path.join(dir, 'ledger.jsonl')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const evaluate = (s: HypothesisSpec, series: SeriesInput[], ledgerFile: string, hash = specHash(s)) =>
  evaluateSpec({ spec: s, hash, series, ledgerFile, runId: 'r', readAtIso: '2026-11-06T00:00:00.000Z' }).series;
const one = (candles: Candle[], symbol = 'SOLUSDT'): SeriesInput => ({ symbol, timeframe: '1h', candles });
const ledgerLines = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0);

describe('simulateLong fills', () => {
  /** Flat series with one breakout signal at bar 220 (close 103); `afterEntry` overrides bars 221 onward. */
  const scenario = (afterEntry: Array<Partial<Candle>>, roundTripBps = 0): SimInput => {
    const candles = Array.from({ length: FLAT_BARS }, (_, i): Candle => ({ openTime: i * HOUR_MS, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    candles[220] = { ...candles[220]!, high: 103.5, close: 103 };
    afterEntry.forEach((bar, k) => { candles[221 + k] = { ...candles[221 + k]!, ...bar }; });
    return { candles, eligible: candles.map(() => true), atr: candles.map(() => 2), params: { ...PARAMS, maxHoldingBars: 5 }, roundTripBps };
  };
  const tradeOf = (input: SimInput) => simulateLong(input, { start: 0, end: FLAT_BARS }).find((t) => t.entryTime === 221 * HOUR_MS)!;
  const calm: Partial<Candle> = { open: 103, low: 102, high: 104, close: 103 };
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

  it('enters at the next bar open, not the signal close', () => {
    // Entry 101 (next open), risk 3: stop 98 is never touched, time exit at 104 gives +1R. Entry at the signal close 103 would stop at 100.
    near(tradeOf(scenario([{ open: 101, low: 100, high: 102, close: 101 }, {}, {}, {}, { close: 104, high: 104.5 }])).netR, 1);
  });

  it('takes the stop first when one bar touches stop and target', () => {
    near(tradeOf(scenario([{ open: 103, low: 100, high: 110 }])).netR, -1);
  });

  it('charges the round-trip cost on the entry notional', () => {
    near(tradeOf(scenario([{ open: 103, low: 100, high: 110 }], 15)).netR, (100 - 103 - 0.0015 * 103) / 3);
  });

  it('fills a gap through the stop at the open', () => {
    near(tradeOf(scenario([calm, { open: 90, low: 89, high: 91 }])).netR, (90 - 103) / 3);
  });

  it('exits at the target, or at the close of the last held bar', () => {
    near(tradeOf(scenario([{ open: 103, low: 102, high: 110 }])).netR, 2);
    near(tradeOf(scenario([calm, calm, calm, calm, { ...calm, close: 104.5, high: 105 }])).netR, 0.5);
  });

  it('keeps the whole hold inside the range, including a signal whose hold ends on the last bar', () => {
    const input = scenario([calm, calm, calm, calm, calm]);
    assert.equal(simulateLong(input, { start: 0, end: 226 }).length, 1);
    assert.equal(simulateLong(input, { start: 0, end: 225 }).length, 0);
  });
});

describe('evaluation stage: no lookahead', () => {
  const candles = walk(1500, 7, false);
  const run = (series: Candle[]) => simulateLong({ candles: series, eligible: series.map(() => true), atr: series.map((c) => c.close * 0.015), params: PARAMS, roundTripBps: 5 }, { start: 0, end: 1500 });
  const base = run(candles);

  it('never lets bars at or after a cutoff change earlier entries or completed trades, at every cutoff', () => {
    let entriesAtCutoff = 0;
    for (let cutoff = 400; cutoff < 1450; cutoff += 1) {
      const changed = run(perturbFrom(candles, cutoff));
      const entries = (trades: typeof base) => trades.filter((t) => t.entryTime <= cutoff * HOUR_MS).map((t) => t.entryTime);
      const done = (trades: typeof base) => trades.filter((t) => t.entryTime <= (cutoff - PARAMS.maxHoldingBars) * HOUR_MS);
      assert.deepEqual(entries(changed), entries(base), `entries differ at cutoff ${cutoff}`);
      assert.deepEqual(done(changed), done(base), `completed trades differ at cutoff ${cutoff}`);
      if (base.some((t) => t.entryTime === cutoff * HOUR_MS)) entriesAtCutoff += 1;
    }
    assert.ok(entriesAtCutoff >= 10, `only ${entriesAtCutoff} cutoffs had an entry on the boundary bar`);
  });

  it('computes context eligibility from past bars only', () => {
    const series = walk(3000, 11, false);
    const flagsOf = (c: Candle[]) => contextFlags(c, wilderAtr(c, 14), 1800).eligible;
    const baseFlags = flagsOf(series);
    for (let cutoff = 1850; cutoff < 2950; cutoff += 1) {
      assert.deepEqual(flagsOf(perturbFrom(series, cutoff)).slice(0, cutoff), baseFlags.slice(0, cutoff), `flags differ at cutoff ${cutoff}`);
    }
    assert.ok(baseFlags.slice(0, 1900).filter(Boolean).length > 50);
  });

  it('fits the context and train stats on train only, and validation without the test segment', () => {
    const series = walk(6000, 3, false);
    const draft = spec({ status: 'DRAFT', window: { days: 500, endDaysAgo: 0, split: { trainPct: 60, validationPct: 20, testPct: 20 } } });
    withLedger((file) => {
      const [baseRun] = evaluate(draft, [one(series)], file);
      const [trainChanged] = evaluate(draft, [one(perturbFrom(series, 3600))], file);
      const [testChanged] = evaluate(draft, [one(perturbFrom(series, 4800))], file);
      assert.equal(trainChanged!.atrPctMax, baseRun!.atrPctMax);
      assert.deepEqual(trainChanged!.train, baseRun!.train);
      assert.deepEqual(testChanged!.validation, baseRun!.validation);
      assert.ok(baseRun!.train.trades > 5 && baseRun!.validation.trades > 5, `train ${baseRun!.train.trades}, validation ${baseRun!.validation.trades}`);
    });
  });
});

describe('evaluation stage: verdicts', () => {
  it('rarely calls a random walk promising (null calibration)', () => {
    const hits = Array.from({ length: 40 }, (_, k) => withLedger((file) => evaluate(spec(), [one(walk(12000, 100 + k, false))], file)[0]!.verdict));
    assert.ok(hits.filter((v) => v === 'PROMISING').length <= 4);
  });

  it('finds a planted breakout edge', () => {
    const [result] = withLedger((file) => evaluate(spec(), [one(walk(12000, 5, true))], file));
    assert.equal(result!.verdict, 'PROMISING');
  });

  it('needs minOosTrades test trades and at least 20 UTC test days, however strong the edge', () => {
    const [fewDays] = withLedger((file) => evaluate(spec(), [one(walk(2000, 5, true))], file));
    assert.ok(fewDays!.test!.trades >= 10 && fewDays!.test!.summary!.pValue < 0.01, `n ${fewDays!.test!.trades}`);
    assert.equal(fewDays!.verdict, 'INSUFFICIENT_EVIDENCE');
    const [fewTrades] = withLedger((file) => evaluate(spec({ evidence: { minOosTrades: 1000, alpha: 0.05 } }), [one(walk(12000, 5, true))], file));
    assert.equal(fewTrades!.verdict, 'INSUFFICIENT_EVIDENCE');
  });

  it('corrects across every declared series, counting a tradeless series as p = 1', () => {
    // Seed 195 alone: p = 0.035 over 29 test days. With three series Holm needs p <= 0.025 for it, so it must not pass.
    const borderline = walk(12000, 195, false);
    const flat = Array.from({ length: 3000 }, (_, i): Candle => ({ openTime: i * HOUR_MS, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    withLedger((file) => assert.equal(evaluate(spec(), [one(borderline)], file)[0]!.verdict, 'PROMISING'));
    const family = withLedger((file) => evaluate(spec(), [one(walk(12000, 5, true)), one(borderline, 'ETHUSDT'), one(flat, 'XRPUSDT')], file));
    assert.deepEqual(family.map((s) => s.verdict), ['PROMISING', 'NOT_SIGNIFICANT', 'INSUFFICIENT_EVIDENCE']);
  });
});

describe('evaluation stage: OOS ledger', () => {
  it('records the first test read, replays quietly, and refuses a changed spec on the same window', () => {
    withLedger((file) => {
      const series = [one(walk(3000, 3, false))];
      assert.equal(evaluate(spec(), series, file)[0]!.ledger, 'first-read');
      assert.equal(evaluate(spec(), series, file)[0]!.ledger, 'replay');
      const [refused] = evaluate(spec(), series, file, 'f'.repeat(64));
      assert.equal(refused!.verdict, 'LEDGER_REFUSED');
      assert.equal(refused!.test, null);
      assert.equal(ledgerLines(file), 1);
    });
  });

  it('writes no ledger line when any series of the spec cannot be evaluated', () => {
    withLedger((file) => {
      assert.throws(() => evaluate(spec(), [one(walk(3000, 3, false)), one(walk(250, 4, false), 'ETHUSDT')], file), /warmup/);
      assert.equal(existsSync(file), false);
    });
  });

  it('keeps the test segment unread and the ledger untouched for a DRAFT spec', () => {
    withLedger((file) => {
      const [result] = evaluate(spec({ status: 'DRAFT' }), [one(walk(3000, 3, false))], file);
      assert.equal(result!.verdict, 'TEST_UNREAD_DRAFT');
      assert.equal(result!.test, null);
      assert.equal(existsSync(file), false);
    });
  });
});
