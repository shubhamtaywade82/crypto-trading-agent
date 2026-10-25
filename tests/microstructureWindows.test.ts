import assert from 'node:assert/strict';
import { test } from 'node:test';
import stringWidth from 'string-width';
import type { MarketState } from '../src/market/types.js';
import { MicroBias, type BiasInput } from '../src/microstructure/MicroBias.js';
import { DEFAULT_MICRO_OPTIONS, MicrostructureEngine } from '../src/microstructure/MicrostructureEngine.js';
import { OfiTracker, ofiIncrement } from '../src/microstructure/Ofi.js';
import { renderLiquidityScreen } from '../src/ui/liquidityPanels.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const T0 = Date.UTC(2026, 9, 25, 10, 0);

// ---- OFI ---------------------------------------------------------------------------------------------------------

test('OFI counts bid adds and ask removals as buy pressure, the reverse as sell pressure', () => {
  const base = { bid: 100, bidQty: 10, ask: 101, askQty: 10 };
  assert.equal(ofiIncrement(base, { ...base, bidQty: 15 }), 5); // bid size added at the same price
  assert.equal(ofiIncrement(base, { ...base, askQty: 4 }), 6); // ask size removed
  assert.equal(ofiIncrement(base, { ...base, bid: 100.5, bidQty: 3 }), 3); // bid stepped up: the new queue counts
  assert.equal(ofiIncrement(base, { ...base, bid: 99.5, bidQty: 8 }), -10); // bid stepped down: the old queue is gone
  assert.equal(ofiIncrement(base, { ...base, ask: 100.5, askQty: 7 }), -7); // ask stepped down
  assert.equal(ofiIncrement(base, base), 0);

  const t = new OfiTracker(60_000);
  t.onTop(base, T0);
  t.onTop({ ...base, bidQty: 20 }, T0 + 1_000); // +10, depth 15
  t.onTop({ ...base, bidQty: 20, askQty: 0.0001 }, T0 + 2_000); // +10, depth ~10
  const w = t.window(T0 + 2_000, 30_000);
  assert.equal(w.updates, 2);
  assert.ok(Math.abs(w.ofi - 19.9999) < 1e-6);
  assert.ok(w.normalized! > 1.5);
  t.reset();
  t.onTop({ ...base, bidQty: 1 }, T0 + 3_000); // first state after a reset: no increment against the stale top
  assert.equal(t.window(T0 + 3_000, 30_000).updates, 2);
});

// ---- bias state machine ------------------------------------------------------------------------------------------

const input = (o: Partial<BiasInput>): BiasInput => ({ valid: true, enter: null, holds: { LONG: false, SHORT: false }, reasons: [], ...o });

test('a bias is adopted only after its entry rule holds continuously for the confirmation time', () => {
  const m = new MicroBias({ confirmMs: 10_000, releaseMs: 30_000 }, T0);
  for (let s = 0; s < 9; s += 1) m.update(input({ enter: 'LONG', holds: { LONG: true, SHORT: false } }), T0 + s * 1_000);
  assert.equal(m.current().bias, 'NEUTRAL');
  assert.deepEqual([m.current().candidate?.bias, m.current().candidate?.needMs], ['LONG', 10_000]);
  m.update(input({}), T0 + 9_500); // one gap resets the clock
  assert.equal(m.current().candidate, null);
  for (let s = 10; s <= 20; s += 1) m.update(input({ enter: 'LONG', holds: { LONG: true, SHORT: false } }), T0 + s * 1_000);
  assert.equal(m.current().bias, 'LONG');
  assert.equal(m.current().since, T0 + 20_000);
});

test('a held bias survives weaker evidence, releases after 30s without support, and flips only on a confirmed opposite', () => {
  const m = new MicroBias({ confirmMs: 10_000, releaseMs: 30_000 }, T0);
  for (let s = 0; s <= 10; s += 1) m.update(input({ enter: 'LONG' }), T0 + s * 1_000);
  assert.equal(m.current().bias, 'LONG');
  for (let s = 11; s <= 60; s += 1) m.update(input({ holds: { LONG: true, SHORT: false } }), T0 + s * 1_000); // entry gone, hold met
  assert.equal(m.current().bias, 'LONG');
  for (let s = 61; s < 90; s += 1) m.update(input({}), T0 + s * 1_000);
  assert.equal(m.current().bias, 'LONG');
  assert.equal(m.current().candidate?.bias, 'NEUTRAL');
  m.update(input({}), T0 + 91_000);
  assert.equal(m.current().bias, 'NEUTRAL');

  const flip = new MicroBias({ confirmMs: 10_000, releaseMs: 30_000 }, T0);
  for (let s = 0; s <= 10; s += 1) flip.update(input({ enter: 'LONG' }), T0 + s * 1_000);
  for (let s = 11; s <= 20; s += 1) flip.update(input({ enter: 'SHORT' }), T0 + s * 1_000);
  assert.equal(flip.current().bias, 'LONG');
  flip.update(input({ enter: 'SHORT' }), T0 + 21_000);
  assert.equal(flip.current().bias, 'SHORT');
});

test('invalid data clears the bias at once, without waiting for confirmation', () => {
  const m = new MicroBias({ confirmMs: 10_000, releaseMs: 30_000 }, T0);
  for (let s = 0; s <= 10; s += 1) m.update(input({ enter: 'SHORT' }), T0 + s * 1_000);
  assert.equal(m.current().bias, 'SHORT');
  m.update({ valid: false, enter: null, holds: { LONG: false, SHORT: false }, reasons: [] }, T0 + 11_000);
  assert.deepEqual([m.current().bias, m.current().reasons], ['NEUTRAL', ['book not live']]);
});

// ---- engine: windows, bias, tiers --------------------------------------------------------------------------------

/** A live engine; `tick` keeps the book live once a second and moves the touch to `bid`/`ask`. */
function engine() {
  const e = new MicrostructureEngine('SOLUSDT', DEFAULT_MICRO_OPTIONS);
  const bids = Array.from({ length: 300 }, (_, i) => ({ price: Number((100 - i * 0.01).toFixed(2)), qty: 50 }));
  const asks = Array.from({ length: 300 }, (_, i) => ({ price: Number((100.02 + i * 0.01).toFixed(2)), qty: 50 }));
  e.onSnapshot({ lastUpdateId: 100, bids, asks });
  let u = 100;
  e.onDepth({ U: 100, u: 101, pu: 99, E: T0, b: [], a: [] }, T0);
  u = 101;
  /** Applies level updates; a new best bid/ask also clears the levels it crosses, as the venue's own diff would. */
  const tick = (t: number, b: Array<[number, number]> = [], a: Array<[number, number]> = []) => {
    const bids = [...b];
    const asks = [...a];
    const topBid = b.length ? Math.max(...b.map(([p]) => p)) : null;
    const topAsk = a.length ? Math.min(...a.map(([p]) => p)) : null;
    if (topBid !== null) for (const [p] of e.book.levels('asks')) if (p <= topBid) asks.push([p, 0]);
    if (topAsk !== null) for (const [p] of e.book.levels('bids')) if (p >= topAsk) bids.push([p, 0]);
    e.onDepth({ U: u + 1, u: u + 1, pu: u, E: t, b: bids.map(([p, q]) => [String(p), String(q)] as const), a: asks.map(([p, q]) => [String(p), String(q)] as const) }, t);
    u += 1;
    assert.equal(e.book.status, 'LIVE', `book broke at ${t}: ${e.book.reason}`);
  };
  return { e, tick };
}

test('windows report their own flow, OFI and price, and are flagged incomplete until the feed has been live that long', () => {
  const { e, tick } = engine();
  for (let s = 0; s <= 40; s += 1) {
    const t = T0 + s * 1_000;
    tick(t, [[100, 50 + s]]); // the bid queue keeps growing: positive OFI
    e.onTrade({ time: t - 10, price: 100.02, qty: 2, buyerIsMaker: false });
    e.sample(t);
  }
  const r = e.reading(T0 + 40_000);
  assert.deepEqual(r.windows.map((w) => [w.ms, w.complete]), [[5_000, true], [30_000, true], [120_000, false], [300_000, false]]);
  assert.ok(r.windows.every((w) => w.delta === 1));
  assert.ok(r.windows[1].ofi! > 0);
  assert.equal(r.windows[1].signedQty, 60);
  assert.equal(r.windows[0].priceBps, 0);
  assert.equal(r.windows[2].priceBps, null); // no mid 2 minutes back
});

test('sustained buying with an agreeing 2m backdrop confirms LONG; a 5s burst against the backdrop does not', () => {
  const { e, tick } = engine();
  let bid = 100;
  for (let s = 0; s <= 150; s += 1) {
    const t = T0 + s * 1_000;
    if (s >= 100) bid = Number((bid + 0.002).toFixed(3)); // last 50 s: price lifts
    const nb = Math.round(bid * 100) / 100;
    tick(t, [[nb, 50]], [[Number((nb + 0.02).toFixed(2)), 50]]);
    for (let k = 0; k < 3; k += 1) e.onTrade({ time: t - 100 + k, price: nb + 0.02, qty: 3, buyerIsMaker: s < 100 ? k === 0 : false });
    e.sample(t);
  }
  const r = e.reading(T0 + 150_000);
  assert.equal(r.windows[1].phase, 'INITIATIVE_BUYING');
  assert.equal(r.bias.bias, 'LONG');
  assert.match(r.bias.reasons[0], /^30s initiative buying, 2m flow 0\.\d\d$/);

  // Five seconds of selling into a buying backdrop is a burst, not a reversal
  for (let s = 151; s <= 156; s += 1) {
    const t = T0 + s * 1_000;
    tick(t);
    for (let k = 0; k < 6; k += 1) e.onTrade({ time: t - 100 + k, price: 100.4, qty: 3, buyerIsMaker: true });
    e.sample(t);
  }
  const after = e.reading(T0 + 156_000);
  assert.ok(after.windows[0].delta! < 0);
  assert.equal(after.bias.bias, 'LONG');

  e.invalidate('stream reconnecting');
  e.sample(T0 + 157_000);
  assert.equal(e.reading(T0 + 157_000).bias.bias, 'NEUTRAL');
});

test('long spans come from coarser tiers whose depth is time-averaged, so a short-lived wall reads faint', () => {
  const { e, tick } = engine();
  for (let s = 0; s <= 20 * 60; s += 1) {
    const t = T0 + s * 1_000;
    // A wall at 99.90: present all the time in the first 10 minutes, for 6 s of each minute after that
    const second = s % 60;
    const wall = s < 600 || second < 6 ? 5_000 : 50;
    tick(t, [[99.9, wall]]);
    e.sample(t);
  }
  const now = T0 + 20 * 60_000;
  const v30 = e.view(now, 21, 100, 30 * 60_000).field!;
  assert.equal(v30.resolutionMs, 20_000); // 10 s tier, merged 2:1 to fit 100 cells
  assert.equal(v30.cellWidths.reduce((a, b) => a + b, 0), 100);
  const row = v30.rowPrices.findIndex((p) => Math.abs(p - 99.9) < 1e-9);
  const cells = v30.cells[row];
  const known = cells.filter((c) => !c.unknown);
  const early = known.slice(0, 25).map((c) => c.bid);
  const late = known.slice(-25).map((c) => c.bid);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(early) > mean(late) + 0.2, `persistent ${mean(early).toFixed(2)} vs flickering ${mean(late).toFixed(2)}`);
  // 30 m span at 20 s per column is 90 columns; 20 m of history fills the last 60, so the first 29 are unmeasured
  assert.equal(v30.cols, 90);
  assert.ok(cells.slice(0, 29).every((c) => c.unknown));

  const v2h = e.view(now, 21, 100, 2 * 3_600_000).field!;
  assert.equal(v2h.resolutionMs, 120_000);
  const v2m = e.view(now, 21, 100, 120_000).field!;
  assert.deepEqual([v2m.resolutionMs, v2m.cols], [2_000, 60]);
  assert.equal(v2m.cellWidths.reduce((a, b) => a + b, 0), 100);
});

// ---- renderer ----------------------------------------------------------------------------------------------------

const context = (h1: 'BULLISH' | 'BEARISH') => ({
  ltfStructure: { trend: 'BULLISH' }, htfStructure: { trend: h1 }, timeframes: { '4h': { lastClose: 100, ema50: 90 } },
}) as unknown as MarketState;

test('the screen shows every window, the bias with its confirmation progress, and the closed-candle context', () => {
  const { e, tick } = engine();
  for (let s = 0; s <= 105; s += 1) {
    const t = T0 + s * 1_000;
    const nb = Number((100 + Math.max(0, s - 95) * 0.01).toFixed(2));
    tick(t, [[nb, 50]], [[Number((nb + 0.02).toFixed(2)), 50]]);
    for (let k = 0; k < 3; k += 1) e.onTrade({ time: t - 50 + k, price: nb + 0.02, qty: 3, buyerIsMaker: false });
    e.sample(t);
  }
  const feed = { tick: 1, state: 'live' as const, lastError: null, symbols: ['SOLUSDT'], view: (_s: string, r: number, c: number, span?: number) => e.view(T0 + 105_000, r, c, span) };
  for (const spanMs of [120_000, 300_000, 1_800_000, 7_200_000]) {
    const lines = renderLiquidityScreen({ feed, symbols: ['SOLUSDT'], selectedSymbol: 'SOLUSDT', showLadder: false, spanMs, marketStates: { SOLUSDT: context('BEARISH') }, time: '', totalWidth: 170, totalHeight: 55 });
    assert.equal(lines.length, 54);
    for (const l of lines) assert.equal(stringWidth(strip(l)), 170);
  }
  const text = renderLiquidityScreen({ feed, symbols: ['SOLUSDT'], selectedSymbol: 'SOLUSDT', showLadder: false, spanMs: 300_000, marketStates: { SOLUSDT: context('BEARISH') }, time: '', totalWidth: 170, totalHeight: 55 }).map(strip).join('\n');
  assert.match(text, / +5s +30s +2m\* +5m\*/);
  assert.match(text, /OFI\/depth/);
  assert.match(text, /MICRO BIAS  NEUTRAL  held 1m45s → LONG \d+\/10s/);
  assert.match(text, /context 15m ▲ 1h ▼ 4h ▲ closed/);
  assert.match(text, /LIQUIDITY PRESSURE FIELD 5m/);
  assert.match(text, /w span \(5m\)/);
  assert.match(text, /◀ 5m .*3s\/col · now/);
});
