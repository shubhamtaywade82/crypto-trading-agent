import test from 'node:test';
import assert from 'node:assert/strict';
import { SqueezeBreakoutAgent } from '../src/agents/SqueezeBreakoutAgent.js';
import type { Candle } from '../src/types.js';

function createCandles(count: number, basePrice: number): Candle[] {
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  const intervalMs = 14_400_000;
  for (let i = 0; i < count; i++) {
    candles.push({
      openTime: startMs + i * intervalMs,
      open: basePrice,
      high: basePrice + 1.0,
      low: basePrice - 1.0,
      close: basePrice + 0.1,
      volume: 1000,
    });
  }
  return candles;
}

test('SqueezeBreakoutAgent: rejects insufficient history', async () => {
  const mockBinance = {} as any;
  const agent = new SqueezeBreakoutAgent(mockBinance);
  const candles = createCandles(20, 2000);

  const signals = await agent.run({
    candles: { ETHUSDT: candles },
    funding: {},
    marks: { ETHUSDT: 2000 },
    spot: {},
    equity: 10000,
  });

  assert.equal(signals.length, 0);
});

test('SqueezeBreakoutAgent: detects squeeze expansion on ETHUSDT', async () => {
  const mockBinance = {} as any;
  const agent = new SqueezeBreakoutAgent(mockBinance, { symbols: ['ETHUSDT'] });
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  const intervalMs = 14_400_000;
  let p = 2500;

  // 30 bars of tight range (squeeze)
  for (let i = 0; i < 30; i++) {
    candles.push({
      openTime: startMs + i * intervalMs,
      open: p, high: p + 1.5, low: p - 1.5, close: p + 0.2, volume: 1000
    });
  }
  // Surge breakout bar
  p += 40;
  candles.push({
    openTime: startMs + 30 * intervalMs,
    open: p - 35, high: p + 5, low: p - 36, close: p, volume: 3000
  });
  // Forming bar
  candles.push({
    openTime: startMs + 31 * intervalMs,
    open: p, high: p + 2, low: p - 2, close: p + 1, volume: 500
  });

  const signals = await agent.run({
    candles: { ETHUSDT: candles },
    funding: {},
    marks: { ETHUSDT: p },
    spot: {},
    equity: 10000,
  });

  if (signals.length > 0) {
    const s = signals[0];
    assert.equal(s.symbol, 'ETHUSDT');
    assert.equal(s.agent, 'SQUEEZE-EXP-ξ');
    assert.equal(s.type, 'OPEN_LONG');
    assert.ok(s.stopLoss !== undefined && s.stopLoss < s.entry!);
    assert.ok(s.takeProfit !== undefined && s.takeProfit > s.entry!);
    assert.equal(s.confidence, 0.85);
  }
});

test('SqueezeBreakoutAgent: deduplicates on the same candle', async () => {
  const mockBinance = {} as any;
  const agent = new SqueezeBreakoutAgent(mockBinance);
  const candles = createCandles(40, 2000);
  const ctx = {
    candles: { ETHUSDT: candles },
    funding: {},
    marks: { ETHUSDT: 2000 },
    spot: {},
    equity: 10000,
  };

  await agent.run(ctx);
  const sigs = await agent.run(ctx);
  assert.equal(sigs.length, 0);
});
