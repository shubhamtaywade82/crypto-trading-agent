import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivativesAt, type CrowdingData } from '../src/research/CrowdingReplay.js';

const HOUR = 3_600_000;
const point = (time: number, top: number) => ({
  time, openInterest: 1, openInterestValue: 1, topTraderAccountRatio: 1, topTraderPositionRatio: top, globalAccountRatio: 1, takerBuySellRatio: 1,
});
const data = (over: Partial<CrowdingData>): CrowdingData => ({
  bars15: [], bars1h: [], bars4h: [], takerByHour: new Map(), metrics: [], funding: [], markBefore: () => 0, ...over,
});

test('a metrics snapshot is only usable 5 minutes after its stamp, and stale snapshots are refused', () => {
  const d = data({ metrics: [point(10 * HOUR - 5 * 60_000, 1.1), point(10 * HOUR, 2.0)] });
  assert.equal(derivativesAt(d, 10 * HOUR)!.topTraderPositionLongShortRatio, 1.1, 'the 10:00 stamp is not usable at 10:00');
  assert.equal(derivativesAt(d, 10 * HOUR + 5 * 60_000)!.topTraderPositionLongShortRatio, 2.0);
  assert.equal(derivativesAt(d, 12 * HOUR), null, 'older than an hour: no snapshot rather than a stale one');
});

test('the taker ratio comes from the last fully closed hour as buy / sell volume', () => {
  const d = data({ metrics: [point(10 * HOUR, 1)], takerByHour: new Map([[9 * HOUR, { buy: 60, total: 100 }], [10 * HOUR, { buy: 99, total: 100 }]]) });
  assert.equal(derivativesAt(d, 10 * HOUR + 15 * 60_000)!.takerBuySellRatio, 1.5, 'the forming 10:00 hour is not used');
});
