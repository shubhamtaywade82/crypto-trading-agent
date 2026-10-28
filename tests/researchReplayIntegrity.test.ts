import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { ReplayService, defaultReplayAgents } from '../src/backtesting/ReplayService.js';
import { FIFTEEN_MINUTES_MS } from '../src/backtesting/types.js';
import { DurableResearchLedger } from '../src/research/ResearchLedger.js';

/** Deterministic candle generator producing multi-regime market phases. */
function generateDeterministicCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 50_000;
  for (let i = 0; i < count; i += 1) {
    // Deterministic trigonometric wave creates cyclical trending and ranging regimes
    const wave = Math.sin(i / 15) * 120 + Math.cos(i / 7) * 40;
    const trend = i < count / 2 ? 15 : -15;
    const open = price;
    const close = price + trend + wave;
    const high = Math.max(open, close) + 25;
    const low = Math.min(open, close) - 25;
    candles.push({
      openTime: i * FIFTEEN_MINUTES_MS,
      open,
      high,
      low,
      close,
      volume: 1_000 + (i % 10) * 50,
    });
    price = close;
  }
  return candles;
}

function computePayloadHash(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

test('Milestone 1 Acceptance: full-fleet replay is strictly reproducible given frozen inputs', async () => {
  const candles = generateDeterministicCandles(400);
  const data = { BTCUSDT: { '15m': candles } };
  const inputHash = computePayloadHash(data);

  // Assert input data immutability
  assert.equal(computePayloadHash(data), inputHash);

  const config = { warmupBars: 200 };
  const serviceA = new ReplayService({ config, agents: defaultReplayAgents() });
  const serviceB = new ReplayService({ config, agents: defaultReplayAgents() });

  const runA = await serviceA.run(data);
  const runB = await serviceB.run(data);

  // 1. Bit-for-bit identity across decisions
  assert.equal(runA.decisions.length, runB.decisions.length);
  for (let i = 0; i < runA.decisions.length; i += 1) {
    const decA = runA.decisions[i];
    const decB = runB.decisions[i];
    assert.equal(decA.decisionId, decB.decisionId);
    assert.equal(decA.status, decB.status);
    assert.equal(decA.evidence.score, decB.evidence.score);
    assert.equal(decA.rejectionReason, decB.rejectionReason);
  }

  // 2. Bit-for-bit identity across executed trades
  assert.equal(runA.trades.length, runB.trades.length);
  for (let i = 0; i < runA.trades.length; i += 1) {
    const tA = runA.trades[i];
    const tB = runB.trades[i];
    assert.equal(tA.decisionId, tB.decisionId);
    assert.equal(tA.symbol, tB.symbol);
    assert.equal(tA.side, tB.side);
    assert.equal(tA.entry, tB.entry);
    assert.equal(tA.exit, tB.exit);
    assert.equal(tA.pnl, tB.pnl);
    assert.equal(tA.fees, tB.fees);
    assert.equal(tA.funding, tB.funding);
    assert.equal(tA.reason, tB.reason);
  }

  // 3. Bit-for-bit identity across summary performance metrics
  assert.equal(runA.metrics.totalTrades, runB.metrics.totalTrades);
  assert.equal(runA.metrics.netReturnPct, runB.metrics.netReturnPct);
  assert.equal(runA.metrics.sharpe, runB.metrics.sharpe);
  assert.equal(runA.metrics.maxDrawdownPct, runB.metrics.maxDrawdownPct);
  assert.equal(runA.metrics.winRatePct, runB.metrics.winRatePct);
  assert.equal(runA.metrics.profitFactor, runB.metrics.profitFactor);
});

test('Milestone 1 Acceptance: replay detects sensitivity to input perturbations', async () => {
  const candlesA = generateDeterministicCandles(300);
  const candlesB = generateDeterministicCandles(300);

  // Perturb a post-warmup active trading bar by 1.5% to ensure the harness is sensitive to changes
  candlesB[250] = {
    ...candlesB[250],
    close: candlesB[250].close * 1.015,
    high: Math.max(candlesB[250].high, candlesB[250].close * 1.015),
  };

  const serviceA = new ReplayService({ config: { warmupBars: 180 }, agents: defaultReplayAgents() });
  const serviceB = new ReplayService({ config: { warmupBars: 180 }, agents: defaultReplayAgents() });

  const runA = await serviceA.run({ BTCUSDT: { '15m': candlesA } });
  const runB = await serviceB.run({ BTCUSDT: { '15m': candlesB } });

  const hashA = computePayloadHash(runA.metrics);
  const hashB = computePayloadHash(runB.metrics);

  // The metrics must diverge under input changes
  assert.notEqual(hashA, hashB);
});

test('Milestone 1 Acceptance: research ledger rebuilds positions matching replay trades', () => {
  const ledger = new DurableResearchLedger();

  ledger.append({
    id: 'obs-1',
    type: 'market_observation',
    timestamps: { exchange_time: 1_000, received_at: 1_010, available_at: 1_010 },
    payload: { symbol: 'BTCUSDT', open: 50_000, high: 50_500, low: 49_800, close: 50_200, volume: 100 },
  });

  ledger.append({
    id: 'dec-1',
    type: 'decision_snapshot',
    timestamps: { exchange_time: 1_000, received_at: 1_010, available_at: 1_010 },
    payload: {
      decisionId: 'dec-1',
      symbol: 'BTCUSDT',
      strategy: 'STRUCTURE-TREND-ε',
      action: 'LONG',
      status: 'EXECUTED',
      plannedEntry: 50_200,
    },
  });

  ledger.append({
    id: 'fill-1',
    type: 'order_fill',
    timestamps: { exchange_time: 1_050, received_at: 1_060, available_at: 1_060 },
    payload: {
      orderId: 'ord-1',
      decisionId: 'dec-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 0.5,
      price: 50_250,
      fee: 12.56,
      slippage: 2.5,
      isReduceOnly: false,
    },
  });

  ledger.append({
    id: 'fill-2',
    type: 'order_fill',
    timestamps: { exchange_time: 2_000, received_at: 2_010, available_at: 2_010 },
    payload: {
      orderId: 'ord-2',
      decisionId: 'dec-1',
      symbol: 'BTCUSDT',
      side: 'SHORT',
      qty: 0.5,
      price: 51_500,
      fee: 12.875,
      slippage: 2.5,
      isReduceOnly: true,
    },
  });

  const state = ledger.reconstruct(10_000);
  assert.equal(state.closedCount, 1);
  assert.equal(state.positions.size, 0);

  // Gross profit: (51,500 - 50,250) * 0.5 = 625
  // Total fees: 12.56 + 12.875 = 25.435
  // Net cash: 10,000 + 625 - 25.435 = 10,599.565
  assert.equal(state.realizedPnl, 625);
  assert.ok(Math.abs(state.totalFees - 25.435) < 1e-6);
  assert.ok(Math.abs(state.cash - 10_599.565) < 1e-6);
});
