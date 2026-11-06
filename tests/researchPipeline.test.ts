import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Candle } from '../src/types.js';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { evaluateSpec, simulateLong, type SimInput } from '../src/research/pipeline/evaluate.js';
import { canonicalJson, parseSpec, specHash, type HypothesisSpec } from '../src/research/pipeline/hypothesis.js';
import { decideRead, type OosRead } from '../src/research/pipeline/oosLedger.js';
import { selectSource } from '../src/research/pipeline/sourceSelect.js';

const rawSpec = (): Record<string, unknown> => ({
  schemaVersion: 1,
  id: 'DONCHIAN-BREAKOUT-MTF-V1',
  version: 1,
  status: 'REGISTERED',
  hypothesis: 'Donchian breakout in a bullish low-volatility context',
  family: 'DONCHIAN_BREAKOUT',
  symbols: ['SOLUSDT'],
  timeframes: ['4h', '1h'],
  timeframeRule: 'each timeframe independently',
  context: { id: 'CTX', taxonomyVersion: 'ctx-v1' },
  params: { lookback: 20, stopAtr: 1.5 },
  window: { days: 90, endDaysAgo: 0, endIso: '2026-10-01T00:00:00.000Z', split: { trainPct: 60, validationPct: 20, testPct: 20 } },
  costs: { roundTripBps: 15 },
  evidence: { minOosTrades: 100, alpha: 0.05 },
});

describe('hypothesis spec', () => {
  it('requires a REGISTERED spec to fix its window end', () => {
    const raw = rawSpec();
    delete (raw.window as { endIso?: string }).endIso;
    assert.throws(() => parseSpec(raw, 'test'), /window\.endIso/);
    assert.equal(parseSpec({ ...raw, status: 'DRAFT' }, 'test').status, 'DRAFT');
  });

  it('rejects a sliding offset together with a fixed window end', () => {
    const raw = rawSpec();
    (raw.window as { endDaysAgo: number }).endDaysAgo = 3;
    assert.throws(() => parseSpec(raw, 'test'), /endDaysAgo/);
  });

  it('accepts a complete spec', () => {
    const spec = parseSpec(rawSpec(), 'test');
    assert.equal(spec.id, 'DONCHIAN-BREAKOUT-MTF-V1');
  });

  it('rejects splits that do not sum to 100', () => {
    const raw = rawSpec();
    (raw.window as { split: unknown }).split = { trainPct: 60, validationPct: 20, testPct: 10 };
    assert.throws(() => parseSpec(raw, 'test'), /splits must sum to 100/);
  });

  it('rejects a timeframe outside 15m/1h/4h', () => {
    const raw = { ...rawSpec(), timeframes: ['1d'] };
    assert.throws(() => parseSpec(raw, 'test'), /timeframes/);
  });

  it('requires the multi-timeframe rule to be stated', () => {
    const raw = rawSpec();
    delete raw.timeframeRule;
    assert.throws(() => parseSpec(raw, 'test'), /timeframeRule/);
  });

  it('hash ignores key order but changes when any value changes', () => {
    const a = parseSpec(rawSpec(), 'a');
    const reordered = JSON.parse(canonicalJson(a)) as HypothesisSpec;
    const shuffled = Object.fromEntries(Object.entries(reordered).reverse()) as HypothesisSpec;
    assert.equal(specHash(a), specHash(shuffled));
    const changed = parseSpec({ ...rawSpec(), params: { lookback: 21, stopAtr: 1.5 } }, 'b');
    assert.notEqual(specHash(a), specHash(changed));
  });
});

describe('OOS ledger', () => {
  const read = (over: Partial<OosRead> = {}): OosRead => ({
    specId: 'S',
    specVersion: 1,
    specHash: 'h1',
    symbol: 'SOLUSDT',
    timeframe: '4h',
    testFromIso: '2026-09-01T00:00:00.000Z',
    testToIso: '2026-10-01T00:00:00.000Z',
    readAtIso: '2026-11-06T00:00:00.000Z',
    runId: 'r1',
    ...over,
  });
  const next = (over: Partial<OosRead> = {}) => {
    const { readAtIso: _readAt, runId: _runId, ...rest } = read(over);
    return rest;
  };

  it('allows the first read of a window', () => {
    assert.equal(decideRead([], next()).kind, 'first-read');
  });

  it('treats the same hash on the same window as a replay', () => {
    assert.equal(decideRead([read()], next()).kind, 'replay');
  });

  it('refuses a changed spec hash on an overlapping test window', () => {
    const decision = decideRead([read()], next({ specHash: 'h2', testFromIso: '2026-09-15T00:00:00.000Z' }));
    assert.equal(decision.kind, 'refused');
  });

  it('allows a changed spec on a window that does not overlap', () => {
    const decision = decideRead([read()], next({ specHash: 'h2', testFromIso: '2026-10-01T00:00:00.000Z', testToIso: '2026-11-01T00:00:00.000Z' }));
    assert.equal(decision.kind, 'first-read');
  });

  it('keeps symbols, timeframes and spec ids independent', () => {
    assert.equal(decideRead([read()], next({ specHash: 'h2', timeframe: '1h' })).kind, 'first-read');
    assert.equal(decideRead([read()], next({ specHash: 'h2', symbol: 'ETHUSDT' })).kind, 'first-read');
    assert.equal(decideRead([read()], next({ specHash: 'h2', specId: 'OTHER' })).kind, 'first-read');
  });
});

describe('selectSource', () => {
  it('honours a forced source without probing', async () => {
    const choice = await selectSource('archive', async () => { throw new Error('must not probe'); });
    assert.equal(choice.source, 'archive');
  });

  it('uses the api when fapi answers', async () => {
    assert.equal((await selectSource('auto', async () => ({ ok: true, status: 200 }))).source, 'api');
  });

  it('falls back to the archive on HTTP 451', async () => {
    const choice = await selectSource('auto', async () => ({ ok: false, status: 451 }));
    assert.equal(choice.source, 'archive');
    assert.match(choice.reason, /451/);
  });

  it('falls back to the archive when the probe throws', async () => {
    const choice = await selectSource('auto', async () => { throw new Error('ENOTFOUND'); });
    assert.equal(choice.source, 'archive');
    assert.match(choice.reason, /ENOTFOUND/);
  });
});

describe('evaluation stage', () => {
  const HOUR_MS = 3_600_000;
  const FLAT_BARS = 260;
  const flatBar = (i: number): Candle => ({ openTime: i * HOUR_MS, open: 100, high: 101, low: 99, close: 100, volume: 1 });

  /** Flat series with one breakout signal at index 220 and an injected next bar (the entry bar) plus follow-up bars. */
  const scenario = (afterEntry: Array<Partial<Candle>>): SimInput => {
    const candles = Array.from({ length: FLAT_BARS }, (_, i) => flatBar(i));
    candles[220] = { ...candles[220]!, high: 103.5, close: 103 };
    afterEntry.forEach((bar, k) => { candles[221 + k] = { ...candles[221 + k]!, ...bar }; });
    const params = { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 5 };
    return { candles, eligible: candles.map(() => true), atr: candles.map(() => 2), params, roundTripBps: 0 };
  };
  const calm: Partial<Candle> = { open: 103, low: 102, high: 104, close: 103 };
  const only = (input: SimInput) => simulateLong(input, { start: 0, end: FLAT_BARS }).filter((t) => t.entryTime === 221 * HOUR_MS);

  it('enters at the next open and takes the stop first when one bar touches stop and target', () => {
    const [trade] = only(scenario([{ open: 103, low: 100, high: 110 }]));
    assert.equal(trade!.netR, -1);
  });

  it('fills a gap through the stop at the open', () => {
    const [trade] = only(scenario([calm, { open: 90, low: 89, high: 91 }]));
    assert.ok(Math.abs(trade!.netR - (90 - 103) / 3) < 1e-9);
  });

  it('exits at the target, or at the close of the last held bar', () => {
    assert.equal(only(scenario([{ open: 103, low: 102, high: 110 }]))[0]!.netR, 2);
    const timeExit = scenario([calm, calm, calm, calm, { ...calm, close: 104.5, high: 105 }]);
    assert.ok(Math.abs(only(timeExit)[0]!.netR - 0.5) < 1e-9);
  });

  const walk = (bars: number, seed: number, plantedEdge: boolean): Candle[] => {
    const rand = mulberry32(seed);
    const candles: Candle[] = [];
    let boost = 0;
    let close = 100;
    for (let i = 0; i < bars; i += 1) {
      const open = close;
      close = open * (1 + (rand() + rand() + rand() - 1.5) * 0.02 + (boost > 0 ? 0.015 : 0));
      boost = Math.max(0, boost - 1);
      const high = Math.max(open, close) * (1 + 0.004 * rand());
      const low = Math.min(open, close) * (1 - 0.004 * rand());
      candles.push({ openTime: i * HOUR_MS, open, high, low, close, volume: 1 });
      const priorHigh = Math.max(...candles.slice(Math.max(0, i - 20), i).map((c) => c.high));
      if (plantedEdge && i >= 20 && close > priorHigh) boost = 3;
    }
    return candles;
  };

  it('never lets bars after an exit change that trade (no lookahead)', () => {
    const candles = walk(1500, 7, false);
    const run = (series: Candle[]) => simulateLong({ candles: series, eligible: series.map(() => true), atr: series.map((c) => c.close * 0.015), params: { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 }, roundTripBps: 5 }, { start: 0, end: 1500 });
    const future = candles.map((c, i) => (i < 1000 ? c : { ...c, open: c.open * 3, high: c.high * 4, low: c.low * 0.2, close: c.close * 0.5 }));
    const cutoff = 1000 * HOUR_MS - 14 * HOUR_MS;
    const before = (trades: ReturnType<typeof run>) => trades.filter((t) => t.entryTime < cutoff);
    assert.ok(before(run(candles)).length > 5);
    assert.deepEqual(before(run(candles)), before(run(future)));
  });

  const registered = (over: Record<string, unknown> = {}): HypothesisSpec =>
    parseSpec({ ...rawSpec(), context: { id: 'EMA50_GT_EMA200_ATR14_Q33_TRAIN', taxonomyVersion: 'ctx-v1' }, evidence: { minOosTrades: 10, alpha: 0.05 }, costs: { roundTripBps: 5 }, params: { lookback: 20, stopAtr: 1.5, targetR: 2, maxHoldingBars: 12 }, ...over }, 'test');
  const withLedger = <T>(run: (ledgerFile: string) => T): T => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oos-'));
    try { return run(path.join(dir, 'ledger.jsonl')); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const evaluate = (spec: HypothesisSpec, candles: Candle[], ledgerFile: string, hash = specHash(spec)) =>
    evaluateSpec({ spec, hash, series: [{ symbol: 'SOLUSDT', timeframe: '1h', candles }], ledgerFile, runId: 'r', readAtIso: '2026-11-06T00:00:00.000Z' }).series[0]!;
  const ledgerLines = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').length : 0);

  it('rarely calls a random walk promising (null calibration)', () => {
    const spec = registered();
    const hits = Array.from({ length: 40 }, (_, k) => withLedger((file) => evaluate(spec, walk(12000, 100 + k, false), file).verdict)).filter((v) => v === 'PROMISING');
    assert.ok(hits.length <= 4, `${hits.length}/40 random walks passed at alpha 0.05`);
  });

  it('finds a planted breakout edge', () => {
    const result = withLedger((file) => evaluate(registered(), walk(12000, 5, true), file));
    assert.ok((result.test?.trades ?? 0) >= 10, `test trades ${result.test?.trades}`);
    assert.equal(result.verdict, 'PROMISING');
  });

  it('records the first test read, replays quietly, and refuses a changed spec on the same window', () => {
    withLedger((file) => {
      const spec = registered();
      const candles = walk(3000, 3, false);
      assert.equal(evaluate(spec, candles, file).ledger, 'first-read');
      assert.equal(ledgerLines(file), 1);
      assert.equal(evaluate(spec, candles, file).ledger, 'replay');
      assert.equal(ledgerLines(file), 1);
      const refused = evaluate(spec, candles, file, 'f'.repeat(64));
      assert.equal(refused.verdict, 'LEDGER_REFUSED');
      assert.equal(refused.test, null);
      assert.equal(ledgerLines(file), 1);
    });
  });

  it('keeps the test segment unread and the ledger untouched for a DRAFT spec', () => {
    withLedger((file) => {
      const result = evaluate(registered({ status: 'DRAFT' }), walk(3000, 3, false), file);
      assert.equal(result.verdict, 'TEST_UNREAD_DRAFT');
      assert.equal(result.test, null);
      assert.equal(existsSync(file), false);
    });
  });
});
