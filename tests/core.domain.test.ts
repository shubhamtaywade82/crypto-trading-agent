import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RiskPipeline } from '../src/core/application/risk/RiskPipeline.js';
import { buildPlaceOrderCommand, canTransition, IllegalOrderTransitionError, isTerminal, OrderLifecycle, type OrderState } from '../src/core/domain/execution.js';
import { barClosedEvent, candleDefect } from '../src/core/domain/market.js';
import { isApprovedTrade, type ApprovedTrade, type TradeProposal } from '../src/core/domain/risk.js';
import { signalDefect } from '../src/core/domain/strategy.js';
import { LIMITS, portfolioOf, signalOf, snapshotOf, candlesFromCloses, T0, TEST_SCOPE } from './support/coreFixtures.js';

const STATES: OrderState[] = ['CREATED', 'VALIDATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'UNKNOWN'];

const proposal = (overrides: Partial<TradeProposal> = {}): TradeProposal => {
  const signal = signalOf();
  return { decisionId: 'dec_1', signal, supportingStrategies: [], symbol: signal.symbol, direction: 'LONG', entry: 100, stopLoss: 98, takeProfit: 106, quantity: 0.5, leverage: 1, notional: 50, riskAmount: 1.06, ...overrides };
};

function approved(p = proposal()): ApprovedTrade {
  const pipeline = new RiskPipeline([{ id: 'pass', evaluate: () => null }], { now: () => T0 });
  const market = snapshotOf('BTCUSDT', candlesFromCloses([100, 100]));
  const verdict = pipeline.evaluate(p, { market, portfolio: portfolioOf(), limits: LIMITS, executedDecisionIds: new Set(), haltReason: null, foreignPositionSymbols: [] });
  assert.ok(verdict.approved);
  return verdict.approved;
}

test('the order state machine allows the happy path and nothing after a terminal state', () => {
  const order = new OrderLifecycle('cmd_1');
  for (const next of ['VALIDATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED'] as const) order.transition(next, T0);
  assert.equal(order.state, 'FILLED');
  assert.deepEqual(order.history.map((t) => `${t.from}>${t.to}`), ['CREATED>VALIDATED', 'VALIDATED>SUBMITTED', 'SUBMITTED>ACKNOWLEDGED', 'ACKNOWLEDGED>PARTIALLY_FILLED', 'PARTIALLY_FILLED>FILLED']);
  for (const terminal of STATES.filter(isTerminal)) {
    assert.deepEqual(STATES.filter((to) => canTransition(terminal, to)), [], `${terminal} must be terminal`);
  }
  assert.deepEqual(STATES.filter(isTerminal).sort(), ['CANCELLED', 'EXPIRED', 'FILLED', 'REJECTED', 'UNKNOWN']);
});

test('illegal transitions throw and leave the state untouched', () => {
  const illegal: Array<[OrderState[], OrderState]> = [
    [[], 'SUBMITTED'], [[], 'FILLED'], [['VALIDATED'], 'FILLED'], [['VALIDATED', 'SUBMITTED', 'FILLED'], 'CANCELLED'],
    [['VALIDATED', 'SUBMITTED', 'REJECTED'], 'FILLED'], [['VALIDATED', 'SUBMITTED', 'ACKNOWLEDGED'], 'SUBMITTED'], [['REJECTED'], 'VALIDATED'],
  ];
  for (const [path, bad] of illegal) {
    const order = new OrderLifecycle('cmd_x');
    for (const step of path) order.transition(step, T0);
    const before = order.state;
    assert.throws(() => order.transition(bad, T0), IllegalOrderTransitionError, `${before} -> ${bad}`);
    assert.equal(order.state, before);
    assert.equal(order.history.length, path.length);
  }
});

test('an order command can only be built from a risk-pipeline approval', () => {
  const forged = { proposal: proposal(), decision: { decisionId: 'dec_1', approved: true, findings: [], evaluatedRules: [], decidedAt: T0 } } as ApprovedTrade;
  assert.equal(isApprovedTrade(forged), false);
  assert.throws(() => buildPlaceOrderCommand(forged, T0, TEST_SCOPE), /without a risk-pipeline approval/);
  // A structural copy of a real approval is not the approval
  assert.throws(() => buildPlaceOrderCommand({ ...approved() }, T0, TEST_SCOPE), /without a risk-pipeline approval/);
});

test('the command is immutable, carries its lineage and account, and is the same on every build', () => {
  const token = approved();
  const command = buildPlaceOrderCommand(token, T0, TEST_SCOPE);
  assert.equal(command.side, 'BUY');
  assert.equal(command.decisionId, 'dec_1');
  assert.equal(command.strategyId, 'test-strategy');
  assert.equal(command.strategyVersion, '1.0.0');
  assert.equal(command.stopLoss, 98);
  assert.equal(command.venue, 'paper_exchange');
  assert.equal(command.accountId, TEST_SCOPE.accountId);
  assert.ok(Object.isFrozen(command));
  assert.throws(() => { (command as { quantity: number }).quantity = 99; }, TypeError);
  const again = buildPlaceOrderCommand(token, T0 + 5, TEST_SCOPE);
  assert.equal(again.commandId, command.commandId);
  assert.equal(again.idempotencyKey, command.idempotencyKey);
  assert.notEqual(buildPlaceOrderCommand(approved(proposal({ decisionId: 'dec_2' })), T0, TEST_SCOPE).idempotencyKey, command.idempotencyKey);
  assert.equal(buildPlaceOrderCommand(approved(proposal({ direction: 'SHORT', stopLoss: 102, takeProfit: 94 })), T0, TEST_SCOPE).side, 'SELL');
});

test('a command cannot be built without an account scope on paper_exchange', () => {
  assert.throws(() => buildPlaceOrderCommand(approved(), T0, { venue: 'paper_exchange', accountId: '  ' }), /account scope/);
  assert.throws(() => buildPlaceOrderCommand(approved(), T0, { venue: 'binance', accountId: 'acct' } as unknown as typeof TEST_SCOPE), /account scope/);
});

test('the approved proposal is a frozen copy: mutating the original after approval changes nothing', () => {
  const original = proposal();
  const token = approved(original);
  (original as { quantity: number }).quantity = 999;
  assert.equal(buildPlaceOrderCommand(token, T0, TEST_SCOPE).quantity, 0.5);
});

test('signal geometry is validated per direction', () => {
  assert.equal(signalDefect(signalOf()), null);
  assert.equal(signalDefect(signalOf({ direction: 'SHORT', stopLoss: 102, takeProfit: 94 })), null);
  assert.match(signalDefect(signalOf({ stopLoss: 101 }))!, /LONG needs/);
  assert.match(signalDefect(signalOf({ direction: 'SHORT' }))!, /SHORT needs/);
  assert.match(signalDefect(signalOf({ stopLoss: Number.NaN }))!, /positive finite/);
  assert.match(signalDefect(signalOf({ takeProfit: -1 }))!, /positive finite/);
  assert.match(signalDefect(signalOf({ confidence: 1.2 }))!, /confidence/);
});

test('malformed candles are named, and a bar event id is a pure function of the bar', () => {
  const good = { openTime: T0, open: 100, high: 101, low: 99, close: 100.5, volume: 1 };
  assert.equal(candleDefect(good), null);
  assert.match(candleDefect({ ...good, close: Number.NaN })!, /close/);
  assert.match(candleDefect({ ...good, low: 0 })!, /low/);
  assert.match(candleDefect({ ...good, high: 100.2 })!, /high\/low/);
  assert.match(candleDefect({ ...good, volume: -1 })!, /volume/);
  assert.match(candleDefect({ ...good, openTime: 1.5 })!, /openTime/);
  const event = barClosedEvent('BTCUSDT', '15m', good);
  assert.equal(event.eventId, `BTCUSDT:15m:${T0}`);
  assert.equal(event.closedAt, T0 + 900_000);
  assert.deepEqual(barClosedEvent('BTCUSDT', '15m', { ...good }), event);
});
