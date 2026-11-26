import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSubscriptions, NotificationEngine, type AlertEvent } from '../src/ops/alerts.js';
import type { AuditInput } from '../src/ops/eventStore.js';
import { createOps, type OpsDeps, type OpsHooks } from '../src/ops/hooks.js';
import { TradePlanLedger, type TradePlan } from '../src/ops/tradePlans.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import type { LogEntry, RiskDecision, Signal, TradeRecord } from '../src/types.js';

setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 });

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 3_600_000;
const STRATEGY = 'MOMENTUM-γ';

interface Harness {
  ops: OpsHooks;
  audits: AuditInput[];
  sent: AlertEvent[];
  plans: TradePlanLedger;
  /** Resolves the outstanding Telegram send promises, so delivery statuses have landed. */
  flush: () => Promise<void>;
}

function harness(over: Partial<OpsDeps> & { sendOk?: boolean; subscriptions?: 'signal-off' } = {}): Harness {
  const audits: AuditInput[] = [];
  const sent: AlertEvent[] = [];
  const plans = over.plans ?? new TradePlanLedger(null);
  const subs = over.subscriptions === 'signal-off'
    ? { ...defaultSubscriptions(), classes: { ...defaultSubscriptions().classes, SIGNAL: false } }
    : undefined;
  const deps: OpsDeps = {
    isAudit: true, isAlerts: true,
    store: { append: (input) => { audits.push(input); } },
    engine: new NotificationEngine(subs, { now: () => T0 }),
    send: async (event) => { sent.push(event); return over.sendOk ?? true; },
    now: () => T0,
    seedTrades: [],
    ...over,
    plans,
  };
  const ops = createOps(deps);
  return { ops, audits, sent, plans, flush: () => new Promise((resolve) => setImmediate(resolve)) };
}

const signal = (over: Partial<Signal> = {}): Signal =>
  ({ id: 'sig1', agent: STRATEGY, symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.8, entry: 100, stopLoss: 98, takeProfit: 106, reason: 'ema cross', ts: T0, ...over });
const approved: RiskDecision = { approved: true, positionSizeUsdt: 5_000, leverage: 8, marginType: 'ISOLATED', liqBufferAtr: 3, reason: 'size=$5000 lev=8x' };
const filledLog = (msg = 'FILLED BUY BTCUSDT qty=50.000 orderId=1'): LogEntry => ({ ts: T0, agent: 'EXECUTOR-ε', msg, level: 'success' });
const warnLog = (msg: string): LogEntry => ({ ts: T0, agent: 'EXECUTOR-ε', msg, level: 'warn' });
const flat = { positions: [], marks: {} };
const trade = (over: Partial<TradeRecord> = {}): TradeRecord =>
  ({ symbol: 'BTCUSDT', strategy: STRATEGY, side: 'LONG', entry: 100, exit: 98, qty: 1, pnl: -2, reason: 'STOP LOSS', closedAt: T0 + 60_000, initialRisk: 2, ...over });

test('an approved entry opens its plan under the decisionId, and the card delivery is recorded as SENT', async () => {
  const h = harness();
  h.ops.onGate(signal(), approved, 'sig1-111');
  await h.flush();
  const plan = h.plans.get('sig1-111');
  assert.equal(plan?.status, 'ANNOUNCED');
  assert.equal(plan?.announceNotify, 'SENT');
  assert.equal(plan?.planned.stopLoss, 98);
  assert.equal(plan?.meta.decisionId, 'sig1-111');
  assert.equal(plan?.meta.signalId, 'sig1');
});

test('a failed Telegram send is recorded as FAILED while the plan itself is still written', async () => {
  const h = harness({ sendOk: false });
  h.ops.onGate(signal(), approved, 'sig1-111');
  await h.flush();
  assert.equal(h.plans.get('sig1-111')?.announceNotify, 'FAILED');
  assert.equal(h.plans.get('sig1-111')?.status, 'ANNOUNCED');
});

test('a card our own subscription suppresses is recorded as SUPPRESSED, not as sent', async () => {
  const h = harness({ subscriptions: 'signal-off' });
  h.ops.onGate(signal(), approved, 'sig1-111');
  await h.flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.plans.get('sig1-111')?.announceNotify, 'SUPPRESSED');
});

test('with alerts off the plan is still recorded, with the card marked NOT_ATTEMPTED', async () => {
  const h = harness({ isAlerts: false });
  h.ops.onGate(signal(), approved, 'sig1-111');
  await h.flush();
  assert.equal(h.plans.get('sig1-111')?.status, 'ANNOUNCED');
  assert.equal(h.plans.get('sig1-111')?.announceNotify, 'NOT_ATTEMPTED');
});

test('a refused gate opens no plan, and a signal without levels (a hedge) opens none either', async () => {
  const h = harness();
  h.ops.onGate(signal(), { ...approved, approved: false, reason: 'capacity' }, 'sig1-111');
  h.ops.onGate(signal({ entry: undefined, stopLoss: undefined, takeProfit: undefined }), approved, 'hedge-1');
  await h.flush();
  assert.equal(h.plans.all().length, 0);
});

test('a filled entry moves to FILLED, and the exit closes it with TP, realized entry, PnL and R', async () => {
  const h = harness();
  h.ops.onGate(signal(), approved, 'sig1-111');
  h.ops.onOrder(signal(), approved, filledLog(), flat, 'sig1-111');
  assert.equal(h.plans.get('sig1-111')?.status, 'FILLED');
  h.ops.onExit([trade({ reason: 'TAKE PROFIT', exit: 106, entry: 100.2, pnl: 58, closedAt: T0 + 90_000 })]);
  await h.flush();
  const plan = h.plans.get('sig1-111') as TradePlan;
  assert.equal(plan.status, 'CLOSED');
  assert.equal(plan.result, 'TP');
  assert.equal(plan.exitPrice, 106);
  assert.equal(plan.entryPrice, 100.2);
  assert.equal(plan.pnl, 58);
  assert.ok(Math.abs((plan.rMultiple ?? NaN) - (5.8 / 2)) < 1e-9, 'R is measured against the planned 2-point stop');
  assert.equal(plan.closeNotify, 'SENT');
});

test('a resting live limit stays ANNOUNCED until its realized close arrives', () => {
  const h = harness();
  h.ops.onGate(signal(), approved, 'sig1-111');
  h.ops.onOrder(signal(), approved, filledLog('SUBMITTED BUY BTCUSDT qty=50.000 orderId=1'), flat, 'sig1-111');
  assert.equal(h.plans.get('sig1-111')?.status, 'ANNOUNCED');
  h.ops.onExit([trade({ reason: 'STOP LOSS' })]);
  assert.equal(h.plans.get('sig1-111')?.status, 'CLOSED');
  assert.equal(h.plans.get('sig1-111')?.result, 'SL');
});

test('an order the venue refused marks the plan NOT_FILLED with the venue reason', () => {
  const h = harness();
  h.ops.onGate(signal(), approved, 'sig1-111');
  h.ops.onOrder(signal(), approved, warnLog('EXECUTION REFUSED: insufficient margin'), flat, 'sig1-111');
  const plan = h.plans.get('sig1-111');
  assert.equal(plan?.status, 'NOT_FILLED');
  assert.equal(plan?.note, 'EXECUTION REFUSED: insufficient margin');
});

test('a partial take-profit does not close the plan, and the final exit still resolves it (regression: lineage survived the partial)', () => {
  const h = harness();
  h.ops.onGate(signal(), approved, 'sig1-111');
  h.ops.onOrder(signal(), approved, filledLog(), flat, 'sig1-111');
  h.ops.onExit([trade({ reason: 'PARTIAL TP', partial: true, exit: 104, pnl: 6, closedAt: T0 + 30_000 })]);
  assert.equal(h.plans.get('sig1-111')?.status, 'FILLED');
  assert.equal(h.plans.get('sig1-111')?.partials.length, 1);
  h.ops.onExit([trade({ reason: 'STOP LOSS', exit: 98, pnl: -8, closedAt: T0 + 60_000 })]);
  assert.equal(h.plans.get('sig1-111')?.status, 'CLOSED');
  assert.equal(h.plans.get('sig1-111')?.result, 'SL');
  // The audit trail attributes the final exit to the same signal, which it could not do before the partial kept the lineage
  const finalExit = h.audits.filter((a) => a.type === 'exit').at(-1);
  assert.equal(finalExit?.decisionId, 'sig1');
});

test('an exit that cannot be attributed to any plan changes no plan', () => {
  const h = harness();
  h.ops.onGate(signal(), approved, 'sig1-111');
  h.ops.onExit([trade({ symbol: 'ETHUSDT', reason: 'STOP LOSS' })]);
  assert.equal(h.plans.get('sig1-111')?.status, 'ANNOUNCED');
});

test('restart: a plan whose position closed while we were down is closed from the journal, not left open', () => {
  const plans = new TradePlanLedger(null);
  plans.announce({ planId: 'old', source: 'SIGNAL', symbol: 'BTCUSDT', side: 'LONG', strategy: STRATEGY, at: T0 - 2 * HOUR, planned: { entry: 100, stopLoss: 98, takeProfit: 106 }, meta: { signalId: 'sig0' } });
  plans.fill('old', T0 - 2 * HOUR);
  const h = harness({ plans, seedTrades: [trade({ reason: 'TAKE PROFIT', exit: 106, pnl: 60, closedAt: T0 - HOUR })] });
  assert.equal(h.plans.get('old')?.status, 'CLOSED');
  assert.equal(h.plans.get('old')?.result, 'TP');
});

test('restart: a plan whose position is still open is re-adopted, so its later exit is attributed to it', () => {
  const plans = new TradePlanLedger(null);
  plans.announce({ planId: 'open', source: 'SIGNAL', symbol: 'BTCUSDT', side: 'LONG', strategy: STRATEGY, at: T0 - HOUR, planned: { entry: 100, stopLoss: 98, takeProfit: 106 }, meta: { signalId: 'sig9' } });
  plans.fill('open', T0 - HOUR);
  const h = harness({ plans, seedTrades: [] });
  assert.equal(h.plans.get('open')?.status, 'FILLED');
  h.ops.onExit([trade({ reason: 'STOP LOSS', closedAt: T0 + 60_000 })]);
  assert.equal(h.plans.get('open')?.status, 'CLOSED');
  assert.equal(h.audits.filter((a) => a.type === 'exit').at(-1)?.decisionId, 'sig9');
});

test('restart: an older plan with no journaled close, superseded by a newer fill, is UNOBSERVED; the newer one stays open', () => {
  const plans = new TradePlanLedger(null);
  plans.announce({ planId: 'older', source: 'SIGNAL', symbol: 'BTCUSDT', side: 'LONG', strategy: STRATEGY, at: T0 - 3 * HOUR, planned: { entry: 100, stopLoss: 98, takeProfit: 106 } });
  plans.fill('older', T0 - 3 * HOUR);
  plans.announce({ planId: 'newer', source: 'SIGNAL', symbol: 'BTCUSDT', side: 'LONG', strategy: STRATEGY, at: T0 - HOUR, planned: { entry: 101, stopLoss: 99, takeProfit: 107 } });
  plans.fill('newer', T0 - HOUR);
  const h = harness({ plans, seedTrades: [] });
  assert.equal(h.plans.get('older')?.result, 'UNOBSERVED');
  assert.equal(h.plans.get('older')?.rMultiple, null, 'an unobserved outcome must not carry a number');
  assert.equal(h.plans.get('newer')?.status, 'FILLED');
});

test('replaying the journal on restart does not duplicate partials already on the books', () => {
  const plans = new TradePlanLedger(null);
  plans.announce({ planId: 'p', source: 'SIGNAL', symbol: 'BTCUSDT', side: 'LONG', strategy: STRATEGY, at: T0 - HOUR, planned: { entry: 100, stopLoss: 98, takeProfit: 106 } });
  plans.fill('p', T0 - HOUR);
  plans.partial('p', { at: T0 - 1000, exitPrice: 104, pnl: 6 });
  harness({ plans, seedTrades: [trade({ reason: 'PARTIAL TP', partial: true, exit: 104, pnl: 6, closedAt: T0 - 1000 })] });
  assert.equal(plans.get('p')?.partials.length, 1);
});
