import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWeeks, DAY_MS, fundingSum, netReturn, runPortfolio, scoreWeeks, SIDE_COST_RATE, type Panel, type SymbolDays } from '../src/research/CrossSection.js';

const START = Date.UTC(2021, 0, 4); // a Monday
const DAYS = 160;

/** Symbol i drifts at i bps/day; every symbol trades 50 M USDT a day. */
function drifting(i: number): SymbolDays {
  const open = new Float64Array(DAYS);
  const close = new Float64Array(DAYS);
  for (let d = 0; d < DAYS; d += 1) {
    open[d] = 100 * (1 + i * 1e-4) ** d;
    close[d] = 100 * (1 + i * 1e-4) ** (d + 1);
  }
  return { open, close, quoteVolume: new Float64Array(DAYS).fill(50_000_000) };
}

function panel(fundingPerSettlement = 0): Panel {
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}USDT`);
  const funding = symbols.map(() => ({ time: [START + 100 * DAY_MS], cum: [fundingPerSettlement] }));
  return { start: START, days: DAYS, symbols, data: symbols.map((_, i) => drifting(i)), funding };
}

test('should earn the drift spread when momentum ranks symbols by past return', () => {
  const p = panel();
  const weeks = buildWeeks(p, START + 100 * DAY_MS, START + 140 * DAY_MS);
  const [first] = runPortfolio(weeks, scoreWeeks(p, weeks, 'X2'), 6);
  assert.ok(first!.gross > 0.005, `gross ${first!.gross}`); // top-6 minus bottom-6 drift over 7 days is ~0.7%
  assert.equal(first!.cost, SIDE_COST_RATE * 2); // 12 names, each |weight| 1/6, entering from flat: turnover 2
});

test('should not charge a symbol again when the basket is unchanged week to week', () => {
  const p = panel();
  const weeks = buildWeeks(p, START + 100 * DAY_MS, START + 140 * DAY_MS);
  const results = runPortfolio(weeks, scoreWeeks(p, weeks, 'X2'), 6);
  assert.equal(results[1]!.cost, 0);
});

test('should count a settlement once, to the position held before it', () => {
  const f = { time: [10, 20, 30], cum: [1, 3, 6] };
  assert.equal(fundingSum(f, 10, 30), 5); // (10, 30] = settlements at 20 and 30
  assert.equal(fundingSum(f, 0, 9), 0);
});

test('should make a long pay positive funding and a short receive it', () => {
  const p = panel(0.01);
  const weeks = buildWeeks(p, START + 98 * DAY_MS, START + 98 * DAY_MS);
  const [week] = runPortfolio(weeks, scoreWeeks(p, weeks, 'X2'), 6);
  assert.ok(Math.abs(week!.funding) < 1e-12, 'equal funding on both legs nets to zero');
  assert.ok(netReturn(week!) < week!.gross);
});
