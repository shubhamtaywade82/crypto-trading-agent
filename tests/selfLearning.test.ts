import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLedger } from '../src/learning/AgentLedger.js';
import { confidenceMultiplier } from '../src/learning/ConfidenceAdjuster.js';
import { TradeOutcomeRecorder } from '../src/learning/TradeOutcomeRecorder.js';

function makeLedger(): { ledger: AgentLedger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const ledger = new AgentLedger(join(dir, 'ledger.json'));
  return { ledger, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('AgentLedger: cold start returns null for win-rate and avgR', () => {
  const { ledger, cleanup } = makeLedger();
  assert.equal(ledger.winRate('MOMENTUM-γ' as any), null);
  assert.equal(ledger.avgR('MOMENTUM-γ' as any), null);
  cleanup();
});

test('AgentLedger: win-rate and avgR populate after 3+ trades', () => {
  const { ledger, cleanup } = makeLedger();
  ledger.record('MOMENTUM-γ' as any, true, 2.0);
  ledger.record('MOMENTUM-γ' as any, true, 1.5);
  ledger.record('MOMENTUM-γ' as any, false, -1.0);
  const wr = ledger.winRate('MOMENTUM-γ' as any);
  const avgR = ledger.avgR('MOMENTUM-γ' as any);
  assert.ok(wr !== null && wr >= 0 && wr <= 1, `win-rate should be in [0,1], got ${wr}`);
  assert.ok(avgR !== null, `avgR should be non-null after 3 trades`);
  // 2 wins at +2R and +1.5R, 1 loss at -1R — net expectancy should be positive
  assert.ok(avgR > 0, `avgR should be positive with 2 winning trades, got ${avgR}`);
  cleanup();
});

test('AgentLedger: persists across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'ledger.json');
  const a = new AgentLedger(path);
  a.record('FUNDING-ARB-β' as any, true, 1.5);
  a.record('FUNDING-ARB-β' as any, true, 2.0);
  a.record('FUNDING-ARB-β' as any, false, -0.5);
  const b = new AgentLedger(path);
  assert.ok(b.winRate('FUNDING-ARB-β' as any) !== null, 'should reload from disk');
  rmSync(dir, { recursive: true });
});

test('ConfidenceAdjuster: cold start is 1.0', () => {
  const { ledger, cleanup } = makeLedger();
  assert.equal(confidenceMultiplier('MOMENTUM-γ' as any, ledger), 1.0);
  cleanup();
});

test('ConfidenceAdjuster: proven agent gets multiplier > 1.0', () => {
  const { ledger, cleanup } = makeLedger();
  for (let i = 0; i < 10; i++) ledger.record('MOMENTUM-γ' as any, true, 2.5);
  const mult = confidenceMultiplier('MOMENTUM-γ' as any, ledger);
  assert.ok(mult > 1.0, `expected mult > 1.0, got ${mult}`);
  assert.ok(mult <= 1.2, `multiplier must not exceed 1.2, got ${mult}`);
  cleanup();
});

test('ConfidenceAdjuster: consistently losing agent gets multiplier < 1.0', () => {
  const { ledger, cleanup } = makeLedger();
  for (let i = 0; i < 10; i++) ledger.record('MOMENTUM-γ' as any, false, -1.5);
  const mult = confidenceMultiplier('MOMENTUM-γ' as any, ledger);
  assert.ok(mult < 1.0, `expected mult < 1.0, got ${mult}`);
  assert.ok(mult >= 0.6, `multiplier must not go below 0.6, got ${mult}`);
  cleanup();
});

test('TradeOutcomeRecorder: grades a new exit and skips seen ones', () => {
  const { ledger, cleanup } = makeLedger();
  const recorder = new TradeOutcomeRecorder(ledger);
  const trade = {
    symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ' as any, side: 'LONG' as any,
    entry: 40000, exit: 42000, qty: 0.1, pnl: 200, reason: 'SL' as any,
    closedAt: 1_000_000, initialRisk: 500,
  };
  const first = recorder.process([trade]);
  assert.equal(first.length, 1);
  assert.equal(first[0].rMultiple, 4); // (42000-40000)/500 = 4R

  const second = recorder.process([trade]);
  assert.equal(second.length, 0, 'should not reprocess seen trade');
  cleanup();
});

test('TradeOutcomeRecorder: updates ledger so multiplier adapts after grading', () => {
  const { ledger, cleanup } = makeLedger();
  const recorder = new TradeOutcomeRecorder(ledger);
  const base = { symbol: 'ETHUSDT', strategy: 'CROWDING-ι' as any, side: 'SHORT' as any, entry: 2000, initialRisk: 50 };
  for (let i = 0; i < 3; i++) {
    recorder.process([{ ...base, exit: 1900, qty: 1, pnl: 100, reason: 'TP' as any, closedAt: i + 1 }]);
  }
  const mult = confidenceMultiplier('CROWDING-ι' as any, ledger);
  assert.ok(mult > 1.0, `ledger should push multiplier above 1 after 3 wins, got ${mult}`);
  cleanup();
});
