import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/research/Bootstrap.js';
import { bandReversionF7, btcLeadF6, dailyBreakF9, ignitionF4, openingRangeF5, pullbackF1, retestF2, squeezeF8, sweepF3, type Env, type SignalAt } from '../src/research/IntradaySignals.js';
import { buildFrame, closedBar, type Frame, type MinuteInputs } from '../src/research/MtfFrame.js';

const START = Date.UTC(2022, 0, 1);
const DAYS = 60;
const MINUTES = DAYS * 1440;

function randomWalk(seed: number, length: number): MinuteInputs {
  const rand = mulberry32(seed);
  const open = new Float64Array(length); const high = new Float64Array(length); const low = new Float64Array(length); const close = new Float64Array(length);
  const volume = new Float64Array(length); const takerBuy = new Float64Array(length);
  let price = 100;
  for (let i = 0; i < length; i += 1) {
    const shock = (rand() - 0.5) * 0.004 * (1 + 8 * (rand() > 0.995 ? 1 : 0));
    open[i] = price; price *= 1 + shock; close[i] = price;
    high[i] = Math.max(open[i]!, price) * (1 + rand() * 0.001); low[i] = Math.min(open[i]!, price) * (1 - rand() * 0.001);
    volume[i] = 100 * (0.5 + rand()) * (rand() > 0.99 ? 6 : 1); takerBuy[i] = volume[i]! * (0.2 + 0.6 * rand());
  }
  return { start: START, open, high, low, close, volume, takerBuy };
}

const slice = (m: MinuteInputs, to: number): MinuteInputs => ({ start: m.start, open: m.open.slice(0, to), high: m.high.slice(0, to), low: m.low.slice(0, to), close: m.close.slice(0, to), volume: m.volume.slice(0, to), takerBuy: m.takerBuy.slice(0, to) });
const envFor = (f: Frame): Env => ({ f, regimes: [], hourIndex: new Map(Array.from({ length: Math.floor(f.minutes / 60) }, (_, h) => [START + h * 3_600_000, h] as const)) });

test('should close a higher-timeframe bar only after its last minute', () => {
  assert.equal(closedBar(60, 58), -1);
  assert.equal(closedBar(60, 59), 0);
  assert.equal(closedBar(15, 29), 1);
});

test('should aggregate 1m bars into the right 1h bar', () => {
  const m = randomWalk(1, 180);
  const hour1 = buildFrame(m).tf[60];
  assert.equal(hour1.close[1], m.close[119]);
  assert.equal(hour1.open[1], m.open[60]);
  assert.equal(hour1.high[1], Math.max(...m.high.slice(60, 120)));
});

test('should give every family the same signals whether or not future minutes exist', () => {
  const full = randomWalk(7, MINUTES); const btc = randomWalk(8, MINUTES);
  const cut = 50 * 1440;
  const families = (m: MinuteInputs, b: MinuteInputs): SignalAt[] => {
    const env = envFor(buildFrame(m));
    return [pullbackF1(env, 45), retestF2(env, 24), sweepF3(env, 48), ignitionF4(env, 2), openingRangeF5(env, '08:00'), btcLeadF6(env, b.close, 0.001), bandReversionF7(env, 1.5), squeezeF8(env, 60), dailyBreakF9(env, 5)];
  };
  const withFuture = families(full, btc); const truncated = families(slice(full, cut), slice(btc, cut));
  let fired = 0;
  for (let k = 40 * 1440; k < cut; k += 1) {
    withFuture.forEach((signalAt, i) => {
      const a = signalAt(k); const b = truncated[i]!(k);
      assert.deepEqual(a, b, `family ${i} differs at minute ${k}`);
      if (a) fired += 1;
    });
  }
  assert.ok(fired > 20, `only ${fired} signals fired, the test would be vacuous`);
});
