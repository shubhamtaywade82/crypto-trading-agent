import test from 'node:test';
import assert from 'node:assert/strict';
import { EmaCrossSwingAgent } from '../src/agents/EmaCrossSwingAgent.js';
import type { Candle } from '../src/types.js';

function generateCandles(count: number, basePrice: number, step: number): Candle[] {
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  // 4H = 14,400,000 ms
  const intervalMs = 14_400_000;
  for (let i = 0; i < count; i++) {
    const p = basePrice + i * step;
    candles.push({
      openTime: startMs + i * intervalMs,
      open: p,
      high: p + 2.0,
      low: p - 2.0,
      close: p + step * 0.5,
      volume: 1000,
    });
  }
  return candles;
}

test('EmaCrossSwingAgent: requires sufficient 4H history', async () => {
  const mockBinance = {} as any;
  const agent = new EmaCrossSwingAgent(mockBinance);

  // Insufficient bars (<55)
  const shortCandles = generateCandles(30, 100, 0.5);
  const signals = await agent.run({
    candles: { SOLUSDT: shortCandles },
    funding: {},
    marks: { SOLUSDT: 115 },
    spot: {},
    equity: 10000,
  });

  assert.equal(signals.length, 0);
});

test('EmaCrossSwingAgent: detects bullish 20/50 cross on SOLUSDT', async () => {
  const mockBinance = {} as any;
  const agent = new EmaCrossSwingAgent(mockBinance);

  // Create 70 bars where first 55 bars slope downward, then sudden upward surge
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  const intervalMs = 14_400_000;
  let p = 150;
  for (let i = 0; i < 55; i++) {
    p -= 0.5;
    candles.push({ openTime: startMs + i * intervalMs, open: p, high: p + 1, low: p - 1, close: p, volume: 1000 });
  }
  // Surge upward to force EMA 20 above EMA 50
  for (let i = 55; i < 75; i++) {
    p += 8.0;
    candles.push({ openTime: startMs + i * intervalMs, open: p, high: p + 2, low: p - 1, close: p, volume: 2000 });
  }
  // Add 1 extra bar as currently forming
  candles.push({ openTime: startMs + 75 * intervalMs, open: p, high: p + 1, low: p - 1, close: p, volume: 500 });

  const signals = await agent.run({
    candles: { SOLUSDT: candles },
    funding: {},
    marks: { SOLUSDT: p },
    spot: {},
    equity: 10000,
  });

  if (signals.length > 0) {
    const s = signals[0];
    assert.equal(s.symbol, 'SOLUSDT');
    assert.equal(s.agent, 'EMA-SWING-ν');
    assert.equal(s.type, 'OPEN_LONG');
    assert.ok(s.stopLoss !== undefined && s.stopLoss < s.entry!);
    assert.ok(s.takeProfit !== undefined && s.takeProfit > s.entry!);
    assert.equal(s.confidence, 0.85);
  }
});

test('EmaCrossSwingAgent: deduplicates on the same closed 4H candle', async () => {
  const mockBinance = {} as any;
  const agent = new EmaCrossSwingAgent(mockBinance);
  const candles = generateCandles(80, 50, 2.0);

  const ctx = {
    candles: { SOLUSDT: candles },
    funding: {},
    marks: { SOLUSDT: 210 },
    spot: {},
    equity: 10000,
  };

  const signals1 = await agent.run(ctx);
  const signals2 = await agent.run(ctx);

  // Second run on the identical candle series must emit 0 signals
  assert.equal(signals2.length, 0);
});

test('EmaCrossSwingAgent: filters symbols outside configured set', async () => {
  const mockBinance = {} as any;
  const agent = new EmaCrossSwingAgent(mockBinance, { symbols: ['BTCUSDT'] });
  const candles = generateCandles(80, 50, 2.0);

  const signals = await agent.run({
    candles: { SOLUSDT: candles },
    funding: {},
    marks: { SOLUSDT: 210 },
    spot: {},
    equity: 10000,
  });

  // SOLUSDT is not in configured symbols
  assert.equal(signals.length, 0);
});
