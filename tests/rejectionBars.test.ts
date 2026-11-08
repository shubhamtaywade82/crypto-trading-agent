import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateMinutes, flowBarFromKline, ingestMinutes, minuteCoverageByDay, validateOhlcv } from '../src/market/rejection/bars.js';
import { TIMEFRAME_MS, type FlowBar } from '../src/market/rejection/types.js';
import { SYMBOL, alignedStart, kline, minuteKlines, FLAT } from './rejectionFixtures.js';

const M1 = TIMEFRAME_MS['1m'];

test('validateOhlcv accepts a well-formed minute and a zero-volume minute', () => {
  assert.deepEqual(validateOhlcv(kline(alignedStart('1m'), FLAT), '1m'), { ok: true });
  assert.deepEqual(
    validateOhlcv(kline(alignedStart('1m'), { o: 100, h: 100, l: 100, c: 100, base: 0, quote: 0, takerBuy: 0, trades: 0 }), '1m'),
    { ok: true },
  );
});

test('validateOhlcv rejects misaligned open times, impossible OHLC and bad volumes', () => {
  const t = alignedStart('1m');
  assert.deepEqual(validateOhlcv(kline(t + 1, FLAT), '1m'), { ok: false, reason: 'OPEN_TIME_NOT_ALIGNED' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, h: 98 }), '1m'), { ok: false, reason: 'HIGH_BELOW_LOW' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, c: 105 }), '1m'), { ok: false, reason: 'OHLC_OUTSIDE_RANGE' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, l: -1 }), '1m'), { ok: false, reason: 'NON_POSITIVE_PRICE' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, l: Number.NaN }), '1m'), { ok: false, reason: 'NON_FINITE_PRICE' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, quote: -5 }), '1m'), { ok: false, reason: 'NEGATIVE_OR_NON_FINITE_VOLUME' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, takerBuy: 150 }), '1m'), { ok: false, reason: 'TAKER_BUY_EXCEEDS_VOLUME' });
  assert.deepEqual(validateOhlcv(kline(t, { ...FLAT, trades: 1.5 }), '1m'), { ok: false, reason: 'INVALID_TRADE_COUNT' });
});

test('ingestMinutes collapses identical duplicates and reports them', () => {
  const pxs = [FLAT, FLAT, FLAT];
  const klines = minuteKlines(pxs);
  const report = ingestMinutes(SYMBOL, [...klines, klines[1]!]);
  assert.equal(report.bars.length, 3);
  assert.equal(report.duplicates, 1);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.gaps, []);
  assert.ok(report.bars.every((b) => b.complete && b.timeframe === '1m' && b.minuteCount === 1));
});

test('ingestMinutes excludes a minute with conflicting copies, so it appears as a gap', () => {
  const klines = minuteKlines([FLAT, FLAT, FLAT, FLAT]);
  const conflicting = { ...klines[1]!, close: 100.4 };
  const report = ingestMinutes(SYMBOL, [...klines, conflicting]);
  assert.deepEqual(report.conflicts, [klines[1]!.openTime]);
  assert.equal(report.bars.length, 3);
  assert.deepEqual(report.gaps, [{ fromOpenTime: klines[0]!.openTime, toOpenTime: klines[2]!.openTime, missingMinutes: 1 }]);
});

test('ingestMinutes rejects other symbols and invalid klines without aborting the batch', () => {
  const klines = minuteKlines([FLAT, FLAT]);
  const report = ingestMinutes(SYMBOL, [
    ...klines,
    kline(alignedStart('1m') + 5 * M1, FLAT, 'ETHUSDT'),
    kline(alignedStart('1m') + 6 * M1, { ...FLAT, takerBuy: 999 }),
  ]);
  assert.equal(report.bars.length, 2);
  assert.deepEqual(report.rejected.map((r) => r.reason).sort(), ['SYMBOL_MISMATCH', 'TAKER_BUY_EXCEEDS_VOLUME']);
});

test('ingestMinutes reports the missing span of a gap', () => {
  const start = alignedStart('1m');
  const report = ingestMinutes(SYMBOL, [kline(start, FLAT), kline(start + 4 * M1, FLAT)]);
  assert.deepEqual(report.gaps, [{ fromOpenTime: start, toOpenTime: start + 4 * M1, missingMinutes: 3 }]);
});

test('aggregation sums volumes and preserves the 1m delta total, as the design requires', () => {
  const start = alignedStart('5m');
  const minutes = ingestMinutes(SYMBOL, [
    kline(start, { o: 100, h: 101, l: 99.5, c: 100.2, base: 120, quote: 12_000, takerBuy: 70, trades: 10 }),
    kline(start + M1, { o: 100.2, h: 102, l: 100, c: 101.5, base: 80, quote: 8_100, takerBuy: 20, trades: 7 }),
    kline(start + 2 * M1, { o: 101.5, h: 101.6, l: 99.0, c: 99.4, base: 200, quote: 19_900, takerBuy: 60, trades: 15 }),
    kline(start + 3 * M1, { o: 99.4, h: 100.1, l: 98.9, c: 99.9, base: 50, quote: 4_970, takerBuy: 25, trades: 5 }),
    kline(start + 4 * M1, { o: 99.9, h: 100.5, l: 99.7, c: 100.0, base: 40, quote: 4_000, takerBuy: 19, trades: 4 }),
    kline(start + 5 * M1, { o: 100, h: 100, l: 100, c: 100, base: 1, quote: 100, takerBuy: 0.5, trades: 1 }),
  ]).bars;

  const bars = aggregateMinutes(minutes, '5m');
  assert.equal(bars.length, 1);
  const bar = bars[0]!;
  assert.equal(bar.openTime, start);
  assert.equal(bar.open, 100);
  assert.equal(bar.close, 100.0);
  assert.equal(bar.high, 102);
  assert.equal(bar.low, 98.9);
  assert.equal(bar.baseVolume, 120 + 80 + 200 + 50 + 40);
  assert.equal(bar.takerBuyBaseVolume, 70 + 20 + 60 + 25 + 19);
  assert.equal(bar.trades, 10 + 7 + 15 + 5 + 4);
  assert.equal(bar.complete, true);
  assert.equal(bar.minuteCount, 5);

  const sumOfMinuteDeltas = minutes.slice(0, 5).reduce((acc, m) => acc + (2 * m.takerBuyBaseVolume - m.baseVolume), 0);
  assert.ok(Math.abs((2 * bar.takerBuyBaseVolume - bar.baseVolume) - sumOfMinuteDeltas) < 1e-9);
});

test('a bucket with a missing minute is kept but marked incomplete, never treated as valid', () => {
  const start = alignedStart('5m');
  const klines = minuteKlines(Array.from({ length: 10 }, () => FLAT));
  const shifted = klines.map((k) => ({ ...k, openTime: k.openTime + start - alignedStart('1m') }));
  const minutes = ingestMinutes(SYMBOL, shifted.filter((_, i) => i !== 2)).bars;
  const bars = aggregateMinutes(minutes, '5m');
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.complete, false);
  assert.equal(bars[0]!.minuteCount, 4);
  assert.equal(bars[1]!.complete, true);
});

test('the final bucket is dropped while incomplete, since it may still be forming', () => {
  const start = alignedStart('15m');
  const minutes = ingestMinutes(SYMBOL, [0, 1, 2, 3, 4].map((i) => kline(start + i * M1, FLAT))).bars;
  assert.equal(aggregateMinutes(minutes, '15m').length, 0);
  assert.equal(aggregateMinutes(minutes, '5m').length, 1);
});

test('aggregation rejects non-1m input instead of silently mixing timeframes', () => {
  const native: FlowBar = { ...aggregateMinutes(ingestMinutes(SYMBOL, minuteKlines([FLAT])).bars, '1m')[0]!, timeframe: '5m' };
  assert.throws(() => aggregateMinutes([native], '15m'), /expects 1m bars/);
});

test('flowBarFromKline converts a recorded native 5m kline and rejects an invalid one with a reason', () => {
  const ok = flowBarFromKline(SYMBOL, '5m', {
    openTime: 1_793_972_100_000,
    open: '75892.60',
    high: '75900.00',
    low: '75657.10',
    close: '75791.40',
    volume: '671.152',
    quoteVolume: '50837930.42780',
    trades: 24_914,
    takerBuyBase: '328.483',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.bar.close, 75791.4);
    assert.equal(ok.bar.minuteCount, 5);
    assert.equal(ok.bar.complete, true);
  }

  const bad = flowBarFromKline(SYMBOL, '5m', {
    openTime: 1_793_972_100_000,
    open: '1', high: '2', low: '0.5', close: '1.5',
    volume: '10', quoteVolume: '10', trades: 1, takerBuyBase: '11',
  });
  assert.deepEqual(bad, { ok: false, reason: 'TAKER_BUY_EXCEEDS_VOLUME' });
});

test('minuteCoverageByDay reports present minutes, coverage and gap starts per UTC day', () => {
  const start = alignedStart('1m');
  const day0 = Math.floor(start / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
  const minutes = ingestMinutes(SYMBOL, [0, 1, 2, 5, 6].map((i) => kline(day0 + i * M1, FLAT))).bars;
  const [cov] = minuteCoverageByDay(minutes);
  assert.equal(cov?.present, 5);
  assert.equal(cov?.expected, 1440);
  assert.equal(cov?.gaps, 1);
  assert.ok(Math.abs((cov?.coverage ?? 0) - 5 / 1440) < 1e-12);
});
