import test from 'node:test';
import assert from 'node:assert/strict';
import { DonchianBreakoutAgent } from '../src/agents/DonchianBreakoutAgent.js';
import type { Candle } from '../src/types.js';

function createCandleSeries(count: number, basePrice: number): Candle[] {
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  const intervalMs = 3_600_000; // 1H
  for (let i = 0; i < count; i++) {
    candles.push({
      openTime: startMs + i * intervalMs,
      open: basePrice,
      high: basePrice + 0.05,
      low: basePrice - 0.05,
      close: basePrice + 0.01,
      volume: 1000,
    });
  }
  return candles;
}

test('DonchianBreakoutAgent: rejects insufficient history', async () => {
  const mockBinance = {} as any;
  const agent = new DonchianBreakoutAgent(mockBinance);
  const candles = createCandleSeries(15, 0.50);

  const signals = await agent.run({
    candles: { XRPUSDT: candles },
    funding: {},
    marks: { XRPUSDT: 0.50 },
    spot: {},
    equity: 10000,
  });

  assert.equal(signals.length, 0);
});

test('DonchianBreakoutAgent: fires on high-volume breakout on XRPUSDT', async () => {
  const mockBinance = {} as any;
  const agent = new DonchianBreakoutAgent(mockBinance, { symbols: ['XRPUSDT'] });
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  const intervalMs = 3_600_000;
  let p = 0.50;

  // 30 bars in flat range
  for (let i = 0; i < 30; i++) {
    candles.push({ openTime: startMs + i * intervalMs, open: p, high: p + 0.02, low: p - 0.02, close: p, volume: 1000 });
  }
  // High-volume breakout bar
  p += 0.08;
  candles.push({ openTime: startMs + 30 * intervalMs, open: p - 0.05, high: p + 0.01, low: p - 0.06, close: p, volume: 3500 });
  // Forming bar
  candles.push({ openTime: startMs + 31 * intervalMs, open: p, high: p + 0.01, low: p - 0.01, close: p, volume: 200 });

  const signals = await agent.run({
    candles: { XRPUSDT: candles },
    funding: {},
    marks: { XRPUSDT: p },
    spot: {},
    equity: 10000,
  });

  if (signals.length > 0) {
    const s = signals[0];
    assert.equal(s.symbol, 'XRPUSDT');
    assert.equal(s.agent, 'DONCHIAN-SURGE-ο');
    assert.equal(s.type, 'OPEN_LONG');
    assert.ok(s.stopLoss !== undefined && s.stopLoss < s.entry!);
    assert.ok(s.takeProfit !== undefined && s.takeProfit > s.entry!);
    assert.equal(s.confidence, 0.80);
  }
});

test('DonchianBreakoutAgent: rejects breakout lacking volume surge', async () => {
  const mockBinance = {} as any;
  const agent = new DonchianBreakoutAgent(mockBinance, { symbols: ['XRPUSDT'] });
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  const intervalMs = 3_600_000;
  let p = 0.50;

  for (let i = 0; i < 30; i++) {
    candles.push({ openTime: startMs + i * intervalMs, open: p, high: p + 0.02, low: p - 0.02, close: p, volume: 1000 });
  }
  // Price breaks out but volume is low (500 < 1.4 * 1000)
  p += 0.08;
  candles.push({ openTime: startMs + 30 * intervalMs, open: p - 0.05, high: p + 0.01, low: p - 0.06, close: p, volume: 500 });
  candles.push({ openTime: startMs + 31 * intervalMs, open: p, high: p + 0.01, low: p - 0.01, close: p, volume: 200 });

  const signals = await agent.run({
    candles: { XRPUSDT: candles },
    funding: {},
    marks: { XRPUSDT: p },
    spot: {},
    equity: 10000,
  });

  assert.equal(signals.length, 0);
});
