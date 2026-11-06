import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

  it('rejects alpha at or above 0.5, where the two-sided interval level 1 - 2*alpha is not in (0, 1)', () => {
    assert.throws(() => parseSpec({ ...rawSpec(), evidence: { minOosTrades: 100, alpha: 0.5 } }, 'test'), /alpha/);
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
