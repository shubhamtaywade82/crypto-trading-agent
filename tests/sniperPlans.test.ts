import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createSniperPosition,
  evaluatePositionTick,
  type SmartMoneySignal,
  type SniperPosition,
} from '../src/execution/SmartMoneySniper.js';
import { announceSniperPlan, recordSniperExit, restoreSniperState, sniperPlanId } from '../src/execution/sniperPlans.js';
import { TradePlanLedger } from '../src/ops/tradePlans.js';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);

const signal = (signalId: number, alertPrice = '1'): SmartMoneySignal => ({
  signalId, ticker: 'PEPE2', chainId: 'CT_501', contractAddress: `0xabc${signalId}`, launchPlatform: 'Pumpfun',
  smartSignalType: 'buy', smartMoneyCount: 4, direction: 'buy', alertPrice, currentPrice: alertPrice,
  exitRate: 5, status: 'valid', signalTriggerTime: T0,
});

const positionOf = (signalId: number, alertPrice = '1'): SniperPosition =>
  createSniperPosition(signal(signalId, alertPrice), undefined, T0);

test('an alerted sniper position is announced and filled at its alert price, with its levels as planned', () => {
  const plans = new TradePlanLedger(null);
  const pos = positionOf(7);
  assert.equal(announceSniperPlan(plans, pos), 'SNIPER:7');
  const plan = plans.get('SNIPER:7');
  assert.equal(plan?.source, 'SNIPER');
  assert.equal(plan?.status, 'FILLED');
  assert.deepEqual(plan?.planned, { entry: 1, stopLoss: 0.9, takeProfit: 1.2 });
  assert.equal(plan?.filledAt, T0);
});

test('a take-profit exit closes with TP, the simulated PnL and +2R against the 10% stop', () => {
  const plans = new TradePlanLedger(null);
  const pos = positionOf(7);
  announceSniperPlan(plans, pos);
  const exited = evaluatePositionTick(pos, 1.25, T0 + 60_000);
  assert.equal(recordSniperExit(plans, exited, T0 + 60_000), 'SNIPER:7');
  const plan = plans.get('SNIPER:7');
  assert.equal(plan?.status, 'CLOSED');
  assert.equal(plan?.result, 'TP');
  assert.equal(plan?.pnl, 40);
  assert.ok(Math.abs((plan?.rMultiple ?? NaN) - 2) < 1e-9);
});

test('a stop-loss exit closes with SL at -1R', () => {
  const plans = new TradePlanLedger(null);
  const pos = positionOf(8);
  announceSniperPlan(plans, pos);
  recordSniperExit(plans, evaluatePositionTick(pos, 0.85, T0 + 1_000), T0 + 1_000);
  assert.equal(plans.get('SNIPER:8')?.result, 'SL');
  assert.ok(Math.abs((plans.get('SNIPER:8')?.rMultiple ?? NaN) + 1) < 1e-9);
});

test('a time-stop exit closes with TIME_STOP at the last observed price', () => {
  const plans = new TradePlanLedger(null);
  const pos = positionOf(9);
  announceSniperPlan(plans, pos);
  const expired = evaluatePositionTick(pos, 1.05, pos.expiryTimeMs + 1);
  assert.equal(expired.status, 'EXPIRED');
  recordSniperExit(plans, expired, pos.expiryTimeMs + 1);
  assert.equal(plans.get('SNIPER:9')?.result, 'TIME_STOP');
  assert.equal(plans.get('SNIPER:9')?.exitPrice, 1.05);
});

test('an OPEN position is not an outcome and records nothing', () => {
  const plans = new TradePlanLedger(null);
  const pos = positionOf(10);
  announceSniperPlan(plans, pos);
  assert.equal(recordSniperExit(plans, pos, T0 + 1), undefined);
  assert.equal(plans.get('SNIPER:10')?.status, 'FILLED');
});

test('the same signal is announced once', () => {
  const plans = new TradePlanLedger(null);
  announceSniperPlan(plans, positionOf(11));
  assert.equal(announceSniperPlan(plans, positionOf(11)), undefined);
});

test('restart: announced signals stay processed, and only still-open positions are watched again', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sniper-plans-')), 'trade-plans.jsonl');
  const before = new TradePlanLedger(file);
  const won = positionOf(21);
  const stillOpen = positionOf(22);
  announceSniperPlan(before, won);
  announceSniperPlan(before, stillOpen);
  recordSniperExit(before, evaluatePositionTick(won, 1.3, T0 + 1), T0 + 1);

  const restored = restoreSniperState(new TradePlanLedger(file));
  assert.deepEqual([...restored.processedSignalIds].sort(), [21, 22]);
  assert.deepEqual([...restored.openPositions.keys()], [22]);
  assert.equal(restored.unrecoverable, 0);
  const watched = restored.openPositions.get(22)!;
  assert.equal(watched.entryPrice, stillOpen.entryPrice);
  assert.equal(watched.targetPrice, stillOpen.targetPrice);
  assert.equal(watched.stopPrice, stillOpen.stopPrice);
  assert.equal(watched.expiryTimeMs, stillOpen.expiryTimeMs);
});

test('restart: a restored position still resolves, and its exit is recorded against the same plan', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sniper-plans-')), 'trade-plans.jsonl');
  announceSniperPlan(new TradePlanLedger(file), positionOf(31));

  const plans = new TradePlanLedger(file);
  const watched = restoreSniperState(plans).openPositions.get(31)!;
  const exited = evaluatePositionTick(watched, 0.8, T0 + 5_000);
  assert.equal(exited.status, 'SL_HIT');
  assert.equal(recordSniperExit(plans, exited, T0 + 5_000), sniperPlanId(31));
  assert.equal(new TradePlanLedger(file).get(sniperPlanId(31))?.result, 'SL');
});

test('restart: a recorded position missing the fields needed to rebuild it is reported, not guessed', () => {
  const plans = new TradePlanLedger(null);
  plans.announce({
    planId: 'SNIPER:41', source: 'SNIPER', symbol: 'X', side: 'LONG', strategy: 'SNIPER', at: T0,
    planned: { entry: 1, stopLoss: 0.9, takeProfit: 1.2 }, meta: { signalId: 41 },
  });
  plans.fill('SNIPER:41', T0);
  const restored = restoreSniperState(plans);
  assert.equal(restored.openPositions.size, 0);
  assert.equal(restored.unrecoverable, 1);
  assert.ok(restored.processedSignalIds.has(41), 'it was still announced, so it must not alert again');
});
