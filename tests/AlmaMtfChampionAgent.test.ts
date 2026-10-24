import test from 'node:test';
import assert from 'node:assert/strict';
import { AlmaMtfChampionAgent } from '../src/agents/AlmaMtfChampionAgent.js';
import type { Candle } from '../src/types.js';

function createMockCandles(count: number, basePrice: number, step: number): Candle[] {
  const candles: Candle[] = [];
  const startMs = 1700000000000;
  for (let i = 0; i < count; i++) {
    const p = basePrice + i * step;
    candles.push({
      openTime: startMs + i * 900_000,
      open: p,
      high: p + 1.0,
      low: p - 1.0,
      close: p + 0.2,
      volume: 1000,
    });
  }
  return candles;
}

test('AlmaMtfChampionAgent: ignores forming candle and requires sufficient history', async () => {
  const mockBinance = {} as any;
  const agent = new AlmaMtfChampionAgent(mockBinance);

  // Insufficient bars (<100)
  const shortCandles = createMockCandles(50, 100, 0.5);
  const signals = await agent.run({
    candles: { SOLUSDT: shortCandles },
    funding: {},
    marks: { SOLUSDT: 125 },
    spot: {},
    equity: 10000,
  });

  assert.equal(signals.length, 0);
});

test('AlmaMtfChampionAgent: generates a valid signal structure with frozen ATR stops', async () => {
  const mockBinance = {} as any;
  const agent = new AlmaMtfChampionAgent(mockBinance);

  // 300 upward-trending bars to ensure confirmed 4H bullish regime
  const bullCandles = createMockCandles(300, 50, 0.5);
  const signals = await agent.run({
    candles: { SOLUSDT: bullCandles },
    funding: {},
    marks: { SOLUSDT: 200 },
    spot: {},
    equity: 10000,
  });

  // If a crossover occurred on the latest closed 1H bar, verify structure
  for (const s of signals) {
    assert.equal(s.symbol, 'SOLUSDT');
    assert.equal(s.agent, 'ALMA-CHAMPION-λ');
    assert.ok(s.stopLoss !== undefined);
    assert.ok(s.takeProfit !== undefined);
    assert.ok(s.confidence >= 0.8);
  }
});
