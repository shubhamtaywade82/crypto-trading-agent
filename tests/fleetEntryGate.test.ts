import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  FleetEntryGate, MAX_LIVE_TICK_AGE_MS, evaluateEntryGate, observeEquityState, recordExitState, utcDayKey,
  type EntryGateContext, type GovernorSymbolState,
} from '../src/fleet/EntryGate.js';
import type { RiskLimits } from '../src/risk/riskConfig.js';

const limits: RiskLimits = {
  maxRiskPerTradePercent: 1, maxLeverage: 10, minLeverage: 1,
  maxDailyLossPercent: 3, maxDrawdownPercent: 5, maxLossStreak: 4,
  maxConcurrentPositions: 1, maxSymbolExposurePercent: 100, maxPortfolioGrossExposurePercent: 100,
  maxCorrelatedExposurePercent: 100, maxNotionalPerTrade: 1e9, minRiskRewardRatio: 1,
  feeRateTaker: 0.0004, slippageBufferRate: 0.0002,
};

const DAY = Date.UTC(2026, 10, 17, 12, 0, 0);
const FRESH = DAY - 1_000;

function stateOf(over: Partial<GovernorSymbolState> = {}): GovernorSymbolState {
  return { hwm: 1000, lastEquity: 1000, dayKey: utcDayKey(DAY), dayStartEquity: 1000, dayRealizedPnl: 0, lossStreak: 0, ...over };
}

function ctxOf(over: Partial<EntryGateContext> = {}): EntryGateContext {
  return { operatorHalted: false, maxTickAgeMs: MAX_LIVE_TICK_AGE_MS, limits, state: stateOf(), ...over };
}

const LIVE = { now: DAY, equity: 1000, lastLiveTickAt: FRESH };

test('refuses until an equity snapshot and a live tick are both present', () => {
  const d = evaluateEntryGate({ now: DAY, equity: null, lastLiveTickAt: 0 }, ctxOf({ state: undefined }));
  assert.equal(d.allowed, false);
  assert.equal(d.riskMultiplier, 0);
  assert.match(d.reasons.join(' | '), /no live trade tick received yet/);
  assert.match(d.reasons.join(' | '), /no account equity observed yet/);
});

test('a tick older than the limit refuses, and a fresh one admits', () => {
  const stale = evaluateEntryGate({ now: DAY, equity: 1000, lastLiveTickAt: DAY - 16_000 }, ctxOf());
  assert.equal(stale.allowed, false);
  assert.match(stale.reasons.join(' | '), /last live tick 16s ago \(max 15s\)/);
  const fresh = evaluateEntryGate({ now: DAY, equity: 1000, lastLiveTickAt: DAY - 14_000 }, ctxOf());
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.riskMultiplier, 1);
});

test('the operator kill switch refuses even with fresh data', () => {
  const d = evaluateEntryGate(LIVE, ctxOf({ operatorHalted: true }));
  assert.equal(d.allowed, false);
  assert.match(d.reasons.join(' | '), /operator halt \(kill switch\) is set/);
});

test('the repo circuit breaker scales the risk budget, and refuses at the daily-loss limit', () => {
  const at = (dailyRealized: number) => evaluateEntryGate(LIVE, ctxOf({ state: stateOf({ dayRealizedPnl: dailyRealized }) }));
  assert.deepEqual([at(-10).circuit, at(-10).riskMultiplier], ['NORMAL', 1], '1% daily loss against a 3% limit');
  assert.deepEqual([at(-20).circuit, at(-20).riskMultiplier], ['CAUTION', 0.75], '2% is over half the limit');
  assert.deepEqual([at(-23).circuit, at(-23).riskMultiplier], ['REDUCED', 0.5], '2.3% is over three quarters of the limit');
  const halted = at(-30);
  assert.equal(halted.allowed, false);
  assert.equal(halted.circuit, 'HALTED', '3% is the limit itself');
});

test('a loss streak at the limit halts, and only a winning exit clears it', () => {
  let state = stateOf();
  for (let i = 0; i < 4; i++) state = recordExitState(state, -5, DAY);
  assert.equal(state.lossStreak, 4);
  const halted = evaluateEntryGate(LIVE, ctxOf({ state }));
  assert.equal(halted.allowed, false);
  assert.equal(halted.circuit, 'HALTED');
  assert.match(halted.reasons.join(' | '), /loss streak 4 \(max 4\)/);
  state = recordExitState(state, 8, DAY);
  assert.equal(state.lossStreak, 0);
  assert.equal(evaluateEntryGate(LIVE, ctxOf({ state })).allowed, true);
});

test('a breakeven exit leaves the loss streak where it was', () => {
  assert.equal(recordExitState(stateOf({ lossStreak: 2 }), 0, DAY).lossStreak, 2);
});

test('drawdown at the limit is an emergency, and entries are refused', () => {
  const d = evaluateEntryGate(
    { now: DAY, equity: 950, lastLiveTickAt: FRESH },
    ctxOf({ state: stateOf({ hwm: 1000, lastEquity: 950 }) }),
  );
  assert.equal(d.circuit, 'EMERGENCY');
  assert.equal(d.allowed, false);
});

test('the high-water mark only rises, and a new UTC day restarts the day anchors', () => {
  let state = observeEquityState(undefined, 1000, DAY);
  assert.equal(state.hwm, 1000);
  state = observeEquityState(state, 1100, DAY + 60_000);
  assert.equal(state.hwm, 1100);
  state = observeEquityState(state, 1050, DAY + 120_000);
  assert.equal(state.hwm, 1100, 'a drop leaves the high-water mark where it was');
  assert.equal(state.lastEquity, 1050);
  state = recordExitState(state, -12, DAY + 180_000);
  const nextDay = Date.UTC(2026, 10, 18, 0, 5, 0);
  state = observeEquityState(state, 1040, nextDay);
  assert.equal(utcDayKey(nextDay), '2026-11-18');
  assert.equal(state.dayStartEquity, 1040);
  assert.equal(state.dayRealizedPnl, 0, "yesterday's loss does not count against today");
  assert.equal(state.hwm, 1100);
});

test('exit PnL accumulates within the day, and the streak counts consecutive losers', () => {
  let state = stateOf();
  state = recordExitState(state, -3, DAY);
  state = recordExitState(state, 5, DAY);
  assert.equal(state.dayRealizedPnl, 2);
  assert.equal(state.lossStreak, 0);
  state = recordExitState(state, -1, DAY);
  state = recordExitState(state, -1, DAY);
  assert.equal(state.lossStreak, 2);
});

test('the file-backed gate persists its state, and a fresh instance reloads it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'entry-gate-'));
  const file = path.join(dir, 'ethusdt.json');
  try {
    const gate = new FleetEntryGate({ symbol: 'ETHUSDT', limits, file, operatorHalted: () => false });
    gate.observeEquity(1000, DAY);
    gate.recordExit(-5, DAY);
    assert.ok(existsSync(file));
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as GovernorSymbolState;
    assert.equal(saved.dayRealizedPnl, -5);
    assert.equal(saved.lossStreak, 1);
    const reloaded = new FleetEntryGate({ symbol: 'ETHUSDT', limits, file, operatorHalted: () => false });
    const d = reloaded.decide({ now: DAY, equity: 1000, lastLiveTickAt: FRESH });
    assert.equal(d.allowed, true, '0.5% daily loss is well inside the limit');
    assert.equal(d.riskMultiplier, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the operator halt is read at every decision, not once at startup', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'entry-gate-'));
  try {
    let halted = false;
    const gate = new FleetEntryGate({ symbol: 'ETHUSDT', limits, file: path.join(dir, 'x.json'), operatorHalted: () => halted });
    gate.observeEquity(1000, DAY);
    assert.equal(gate.decide({ now: DAY, equity: 1000, lastLiveTickAt: FRESH }).allowed, true);
    halted = true;
    assert.equal(gate.decide({ now: DAY, equity: 1000, lastLiveTickAt: FRESH }).allowed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable governor file refuses every entry, and is never overwritten', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'entry-gate-'));
  try {
    const bad = path.join(dir, 'solusdt.json');
    writeFileSync(bad, '{not json');
    const gate = new FleetEntryGate({ symbol: 'SOLUSDT', limits, file: bad, operatorHalted: () => false });
    gate.observeEquity(1000, DAY);
    gate.recordExit(-5, DAY);
    const d = gate.decide({ now: DAY, equity: 1000, lastLiveTickAt: FRESH });
    assert.equal(d.allowed, false);
    assert.match(d.reasons.join(' | '), /governor state unreadable/);
    assert.equal(readFileSync(bad, 'utf-8'), '{not json', 'the damaged file is left for an operator to inspect');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
