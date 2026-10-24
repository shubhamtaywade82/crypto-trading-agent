import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_BARS_4H, TrendEnsembleAgent, ensembleSide } from '../src/agents/TrendEnsembleAgent.js';
import type { BinanceService } from '../src/binance/client.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import type { Candle, Position } from '../src/types.js';

const H4 = 4 * 3_600_000;
const T0 = 1_700_006_400_000 - (1_700_006_400_000 % H4);

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ openTime: T0 + i * H4, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
}

function ctx(closes: number[], mark: number): MarketContext {
  return {
    candles: {}, funding: {}, spot: {}, equity: 10_000,
    marks: { SOLUSDT: mark },
    marketDataV2: { SOLUSDT: { candles: { '4h': bars(closes) } } } as unknown as MarketContext['marketDataV2'],
  };
}

const agent = () => new TrendEnsembleAgent({} as BinanceService);
const flat = (n: number) => Array.from({ length: n }, () => 100);

test('ensembleSide follows breakouts and stays flat without them', () => {
  assert.equal(ensembleSide(flat(600)), 0);
  assert.equal(ensembleSide([...flat(599), 120]), 1);
  assert.equal(ensembleSide([...flat(599), 80]), -1);
});

test('ensembleSide exits when the close crosses the midpoint stop', () => {
  // Long after the breakout to 120; the midpoint of the lookback range is 110, so 105 closes it out
  assert.equal(ensembleSide([...flat(598), 120, 105]), 0);
});

test('TrendEnsembleAgent: needs MIN_BARS_4H closed bars', async () => {
  const signals = await agent().run(ctx([...flat(MIN_BARS_4H - 2), 120], 120));
  assert.equal(signals.length, 0);
});

test('TrendEnsembleAgent: enters once on a side change with a 2-ATR stop', async () => {
  const a = agent();
  const closes = [...flat(MIN_BARS_4H), 120];
  const [signal] = await a.run(ctx(closes, 120));
  assert.equal(signal?.type, 'OPEN_LONG');
  assert.ok(signal.stopLoss! < 120 && signal.takeProfit! > 120);
  const rr = (signal.takeProfit! - 120) / (120 - signal.stopLoss!);
  assert.ok(Math.abs(rr - 10) < 1e-9);
  assert.equal((await a.run(ctx(closes, 121))).length, 0); // same closed bar: no repeat
});

test('TrendEnsembleAgent: exitStops moves the stop to the mark only when the ensemble left the side', async () => {
  const a = agent();
  await a.run(ctx([...flat(MIN_BARS_4H), 120], 120));
  const long = { symbol: 'SOLUSDT', side: 'LONG', strategy: 'TREND-ENS-μ', serverTp: '200' } as Position;
  assert.deepEqual(a.exitStops([long], { SOLUSDT: 121 }), []);
  await a.run(ctx([...flat(MIN_BARS_4H), 120, 105], 105));
  const [exit] = a.exitStops([long, { ...long, strategy: 'MOMENTUM-γ' }], { SOLUSDT: 105 });
  assert.equal(exit.stopLoss, 105);
  assert.equal(exit.takeProfit, 200);
});
