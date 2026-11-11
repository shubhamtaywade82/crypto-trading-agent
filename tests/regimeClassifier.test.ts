import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyRegime, confusionMatrix, realizedRegime, regimeFeatures, REGIME_RULES, scoreClasses, transitionStats, type RegimeFeatures,
} from '../src/research/RegimeClassifier.js';
import type { Candle } from '../src/types.js';

const HOUR = 3_600_000;
/** Deterministic bars from a list of per-bar log returns. */
function barsFrom(returns: number[]): Candle[] {
  let close = 100;
  return returns.map((r, i) => {
    const open = close;
    close = open * Math.exp(r);
    return { openTime: i * HOUR, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 };
  });
}
const noise = (n: number, scale = 0.003): number[] => Array.from({ length: n }, (_, i) => scale * Math.sin(i * 1.7) * Math.cos(i * 0.37));
const f = (over: Partial<RegimeFeatures>): RegimeFeatures => ({ adx: 22, volPercentile: 0.5, ret24Sigma: 0, dailySigma: 0.03, ...over });

test('classification follows the fixed rule order: crash, then high vol, then trend/range', () => {
  assert.equal(classifyRegime(f({ ret24Sigma: -3, volPercentile: 0.99, adx: 40 }), undefined), 'STRESS_CRASH');
  assert.equal(classifyRegime(f({}), f({ ret24Sigma: -2.6 })), 'STRESS_CRASH', 'a BTC crash overrides the symbol');
  assert.equal(classifyRegime(f({ volPercentile: 0.85, adx: 40 }), undefined), 'HIGH_VOL_EXPANSION');
  assert.equal(classifyRegime(f({ adx: 30 }), undefined), 'CALM_TREND');
  assert.equal(classifyRegime(f({ adx: 15 }), undefined), 'SIDEWAYS_RANGE');
  assert.equal(classifyRegime(f({ adx: 22 }), undefined), 'UNKNOWN', 'the 20-25 ADX band is undecided, not forced');
  assert.equal(classifyRegime(f({ adx: NaN }), undefined), 'UNKNOWN');
});

test('features at bar i do not change when future bars change (no look-ahead)', () => {
  const base = noise(900);
  const a = regimeFeatures(barsFrom(base));
  const b = regimeFeatures(barsFrom([...base.slice(0, 800), ...base.slice(800).map(() => -0.05)]));
  for (const i of [760, 790, 799]) assert.deepEqual(a[i], b[i]);
  assert.ok(Number.isNaN(a[REGIME_RULES.historyBars - 1]!.volPercentile), 'no percentile before 30 days of history');
});

test('realized label sees a crash and a clean trend in the next 24 bars', () => {
  const history = noise(760);
  const crash = barsFrom([...history, ...Array(24).fill(-0.02)]);
  assert.equal(realizedRegime(crash, 759, regimeFeatures(crash)), 'STRESS_CRASH');
  const trend = barsFrom([...history, ...Array(24).fill(0.0015)]);
  assert.equal(realizedRegime(trend, 759, regimeFeatures(trend)), 'CALM_TREND');
  assert.equal(realizedRegime(trend, 770, regimeFeatures(trend)), 'UNKNOWN', 'not enough future bars');
});

test('scores report precision, recall and lift over the base rate; transitions count label changes', () => {
  const m = confusionMatrix([
    { predicted: 'CALM_TREND', actual: 'CALM_TREND' }, { predicted: 'CALM_TREND', actual: 'SIDEWAYS_RANGE' },
    { predicted: 'SIDEWAYS_RANGE', actual: 'SIDEWAYS_RANGE' }, { predicted: 'UNKNOWN', actual: 'CALM_TREND' },
  ]);
  const trend = scoreClasses(m).find((s) => s.regime === 'CALM_TREND')!;
  assert.equal(trend.precision, 0.5);
  assert.equal(trend.recall, 0.5);
  assert.equal(trend.lift, 1);
  assert.deepEqual(transitionStats(['CALM_TREND', 'CALM_TREND', 'UNKNOWN', 'UNKNOWN']), { meanDwellBars: 2, changesPer100: 25 });
});
