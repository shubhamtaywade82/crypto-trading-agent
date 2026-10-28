import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DurableResearchLedger,
  reconstructState,
  type OrderFillEvent,
  type FundingSettlementEvent,
  type DecisionSnapshotEvent,
} from '../src/research/ResearchLedger.js';

test('ResearchLedger: assigns monotonic seq numbers and timestamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r-ledger-'));
  const file = join(dir, 'research-ledger.jsonl');

  try {
    const ledger = new DurableResearchLedger(file);

    const event = ledger.append({
      id: 'evt-1',
      type: 'decision_snapshot',
      timestamps: {
        exchange_time: 1_700_000_000,
        received_at: 1_700_000_050,
        available_at: 1_700_000_050,
      },
      payload: {
        decisionId: 'dec-1',
        symbol: 'BTCUSDT',
        strategy: 'STRUCT-LIQ-η',
        action: 'LONG',
        status: 'EXECUTED',
        evidenceScore: 82,
        plannedEntry: 50_000,
      },
    });

    assert.equal(event.seq, 1);
    assert.equal(ledger.all().length, 1);

    // Verify recovery on re-open
    const reloaded = new DurableResearchLedger(file);
    assert.equal(reloaded.all().length, 1);
    const loaded = reloaded.all()[0] as DecisionSnapshotEvent;
    assert.equal(loaded.payload.decisionId, 'dec-1');
    assert.equal(loaded.timestamps.exchange_time, 1_700_000_000);
    assert.equal(loaded.timestamps.received_at, 1_700_000_050);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ResearchLedger: reconstructs positions, PnL, fees and funding from events alone', () => {
  const fill1: OrderFillEvent = {
    id: 'f-1',
    seq: 1,
    type: 'order_fill',
    timestamps: { exchange_time: 100, received_at: 101, available_at: 101 },
    payload: {
      orderId: 'o-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 1.0,
      price: 50_000,
      fee: 25, // 0.05% fee
      slippage: 5,
      isReduceOnly: false,
    },
  };

  const funding: FundingSettlementEvent = {
    id: 'fund-1',
    seq: 2,
    type: 'funding_settlement',
    timestamps: { exchange_time: 200, received_at: 201, available_at: 201 },
    payload: {
      symbol: 'BTCUSDT',
      rate: 0.0001,
      markPrice: 51_000,
      positionQty: 1.0,
      payment: 5.1,
    },
  };

  const fill2: OrderFillEvent = {
    id: 'f-2',
    seq: 3,
    type: 'order_fill',
    timestamps: { exchange_time: 300, received_at: 301, available_at: 301 },
    payload: {
      orderId: 'o-2',
      symbol: 'BTCUSDT',
      side: 'SHORT',
      qty: 1.0,
      price: 52_000,
      fee: 26,
      slippage: 5,
      isReduceOnly: true,
    },
  };

  const portfolio = reconstructState([fill1, funding, fill2], 10_000);

  // Initial cash: 10,000
  // Fill 1: -25 fee
  // Funding: -5.1 funding payment
  // Fill 2: +2,000 gross profit, -26 fee
  // Net cash: 10000 - 25 - 5.1 + 2000 - 26 = 11943.9
  assert.equal(portfolio.closedCount, 1);
  assert.equal(portfolio.positions.has('BTCUSDT'), false);
  assert.equal(portfolio.realizedPnl, 2_000);
  assert.equal(portfolio.totalFees, 51);
  assert.equal(portfolio.totalFunding, 5.1);
  assert.ok(Math.abs(portfolio.cash - 11_943.9) < 1e-6);
});
