import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyDonchianL3, hourContext, hourOfDayT1, settlementReboundT2, weeklyMomentumL1 } from '../src/research/CandidateSignals.js';
import type { Regime, RegimeFeatures } from '../src/research/RegimeClassifier.js';
import type { Candle } from '../src/types.js';

const HOUR = 3_600_000;
/** 200 days of hourly bars; UTC hours 14 and 15 rise 0.3% (with noise), every other hour is noise only. */
function bars(): Candle[] {
  return Array.from({ length: 200 * 24 }, (_, i) => {
    const noise = 0.002 * Math.sin(i * 12.9898) ;
    const drift = i % 24 === 14 || i % 24 === 15 ? 0.003 : 0;
    const open = 100;
    const close = open * Math.exp(drift + noise);
    return { openTime: i * HOUR, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 };
  });
}
const ctxFor = (b: Candle[]) => hourContext(b, b.map(() => ({ adx: 20, volPercentile: 0.5, ret24Sigma: 0, dailySigma: 0.02 }) as RegimeFeatures), b.map(() => 'SIDEWAYS_RANGE' as Regime));

test('T1 enters before a drifting hour and holds the whole same-sign block, using only past same-hour bars', () => {
  const b = bars();
  const signalAt = hourOfDayT1(ctxFor(b), 2);
  const hour = 190 * 24 + 13; // closes at 14:00: next hours 14 and 15 drift up
  const signal = signalAt(hour)!;
  assert.equal(signal.side, 1);
  assert.equal(signal.maxHoldMs, 2 * HOUR);
  assert.equal(signalAt(190 * 24 + 3), null, 'noise hours do not pass');
  assert.equal(signalAt(100 * 24 + 13), null, 'fewer than 180 days of history: no statistic');
});

test('T2 goes long after a top-quartile settlement and short after a bottom-quartile one', () => {
  const b = bars();
  const states = [
    { time: 190 * 24 * HOUR, rate: 0.001, high: 0.0005, low: -0.0001, normal: false },
    { time: 191 * 24 * HOUR, rate: -0.001, high: 0.0005, low: -0.0001, normal: false },
    { time: 192 * 24 * HOUR, rate: 0.0001, high: 0.0005, low: -0.0001, normal: true },
  ];
  const signalAt = settlementReboundT2(ctxFor(b), { states }, 4);
  assert.equal(signalAt(190 * 24 - 1)!.side, 1);
  assert.equal(signalAt(191 * 24 - 1)!.side, -1);
  assert.equal(signalAt(192 * 24 - 1), null);
  assert.equal(signalAt(190 * 24 - 1)!.maxHoldMs, 4 * HOUR);
});

test('L1 fires only at Monday 00:00 UTC in the sign of the lookback return; L3 only on a daily close beyond the prior range', () => {
  // 1970-01-05 was a Monday: hour index 4*24-1 closes at Monday 00:00 UTC
  const n = 120 * 24;
  const b: Candle[] = Array.from({ length: n }, (_, i) => ({ openTime: i * HOUR, open: 100 + i * 0.01, high: 100 + i * 0.01 + 0.005, low: 100 + i * 0.01 - 0.005, close: 100 + i * 0.01, volume: 1 }));
  const ctx = ctxFor(b);
  const monday = 4 * 24 - 1 + 7 * 24 * 8;
  const l1 = weeklyMomentumL1(ctx, 28);
  assert.equal(l1(monday)!.side, 1);
  assert.equal(l1(monday - 24), null, 'not a Monday');
  const l3 = dailyDonchianL3(ctx, 20);
  assert.equal(l3(monday)!.side, 1, 'a steady uptrend closes above the prior 20-day high every day');
  assert.equal(l3(monday - 5), null, 'not a day close');
});
