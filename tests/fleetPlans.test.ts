import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fleetPlanId, sendFleetEvent, type FleetTradeEvent } from '../src/fleet/FleetTelegram.js';
import { TradePlanLedger } from '../src/ops/tradePlans.js';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);

const makeFetch = (ok = true) => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return { ok } as Response; }) as unknown as typeof fetch;
  return { fetchImpl, count: () => calls };
};

const CONFIGURED_ENV = { TELEGRAM_TRADING_BOT_TOKEN: 'trading-token', TELEGRAM_CHAT_ID: '42' } as const;

const ENTRY: FleetTradeEvent = {
  kind: 'ENTRY', symbol: 'ETHUSDT', side: 'buy', model: 'qwen3.5:2b', price: 2400.5, quantity: 1, leverage: 10,
  action: 'ENTER_LONG', stopLoss: 2380, takeProfit: 2440, at: T0,
};
const exitOf = (action: string, over: Partial<FleetTradeEvent> = {}): FleetTradeEvent => ({
  kind: 'EXIT', symbol: 'ETHUSDT', side: 'sell', model: 'qwen3.5:2b', price: 2440, quantity: 1, leverage: 10,
  action, stopLoss: 2380, takeProfit: 2440, entryPrice: 2400.5, pnl: 39.5, at: T0 + 60_000, ...over,
});

test('a fleet entry is recorded as a filled plan, and its card delivery is written back', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl } = makeFetch(true);
  await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl, plans });
  const plan = plans.get(fleetPlanId('ETHUSDT', T0));
  assert.equal(plan?.source, 'FLEET');
  assert.equal(plan?.side, 'LONG');
  assert.equal(plan?.strategy, 'qwen3.5:2b');
  assert.equal(plan?.status, 'FILLED');
  assert.equal(plan?.announceNotify, 'SENT');
  assert.deepEqual(plan?.planned, { entry: 2400.5, stopLoss: 2380, takeProfit: 2440 });
});

test('the exit closes the plan with its realized PnL, entry and R; the close card is recorded as SENT', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl } = makeFetch(true);
  await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl, plans });
  await sendFleetEvent(exitOf('TAKE_PROFIT'), { env: CONFIGURED_ENV, fetchImpl, plans });
  const plan = plans.get(fleetPlanId('ETHUSDT', T0));
  assert.equal(plan?.status, 'CLOSED');
  assert.equal(plan?.result, 'TP');
  assert.equal(plan?.pnl, 39.5);
  assert.equal(plan?.entryPrice, 2400.5);
  assert.equal(plan?.closeNotify, 'SENT');
  // (2440 - 2400.5) / (2400.5 - 2380)
  assert.ok(Math.abs((plan?.rMultiple ?? NaN) - 39.5 / 20.5) < 1e-9);
});

test('with FLEET_TELEGRAM=off the trade is still recorded, and the card is marked NOT_ATTEMPTED', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl, count } = makeFetch(true);
  const sent = await sendFleetEvent(ENTRY, { env: { ...CONFIGURED_ENV, FLEET_TELEGRAM: 'off' }, fetchImpl, plans });
  assert.equal(sent, false);
  assert.equal(count(), 0);
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.status, 'FILLED');
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.announceNotify, 'NOT_ATTEMPTED');
});

test('a rejected Telegram send is recorded as FAILED and the plan is kept', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl } = makeFetch(false);
  const sent = await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl, plans });
  assert.equal(sent, false);
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.announceNotify, 'FAILED');
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.status, 'FILLED');
});

test('a stop-loss exit maps to SL and a break-even stop exit maps to BREAK_EVEN; the break-even lock itself changes nothing', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl } = makeFetch(true);
  await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl, plans });
  await sendFleetEvent({ kind: 'BREAK_EVEN', symbol: 'ETHUSDT', model: 'qwen3.5:2b', price: 2420, action: 'BREAK_EVEN', entryPrice: 2400.5, at: T0 + 30_000 }, { env: CONFIGURED_ENV, fetchImpl, plans });
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.status, 'FILLED', 'moving the stop must not close the plan');
  await sendFleetEvent(exitOf('BREAK_EVEN', { pnl: 0 }), { env: CONFIGURED_ENV, fetchImpl, plans });
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.result, 'BREAK_EVEN');
});

test('a new entry while an older plan for the symbol is still open closes the older one as UNOBSERVED', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl } = makeFetch(true);
  await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl, plans });
  await sendFleetEvent({ ...ENTRY, at: T0 + 3_600_000, price: 2500, stopLoss: 2480, takeProfit: 2540 }, { env: CONFIGURED_ENV, fetchImpl, plans });
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.result, 'UNOBSERVED');
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0))?.rMultiple, null);
  assert.equal(plans.get(fleetPlanId('ETHUSDT', T0 + 3_600_000))?.status, 'FILLED');
});

test('an exit with no open plan is sent as before and records nothing', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl, count } = makeFetch(true);
  const sent = await sendFleetEvent(exitOf('STOP_LOSS'), { env: CONFIGURED_ENV, fetchImpl, plans });
  assert.equal(sent, true);
  assert.equal(count(), 1);
  assert.equal(plans.all().length, 0);
});

test('an entry without a usable stop or target is still sent, with no plan written for it', async () => {
  const plans = new TradePlanLedger(null);
  const { fetchImpl, count } = makeFetch(true);
  await sendFleetEvent({ ...ENTRY, stopLoss: undefined, takeProfit: undefined }, { env: CONFIGURED_ENV, fetchImpl, plans });
  assert.equal(count(), 1);
  assert.equal(plans.all().length, 0);
});

test('without a ledger the fleet behaves exactly as before: the card goes out and nothing is recorded', async () => {
  const { fetchImpl, count } = makeFetch(true);
  assert.equal(await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl }), true);
  assert.equal(count(), 1);
});

test('the plan survives a restart of the fleet process', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fleet-plans-')), 'trade-plans.jsonl');
  const { fetchImpl } = makeFetch(true);
  await sendFleetEvent(ENTRY, { env: CONFIGURED_ENV, fetchImpl, plans: new TradePlanLedger(file) });
  await sendFleetEvent(exitOf('STOP_LOSS', { pnl: -20, price: 2380 }), { env: CONFIGURED_ENV, fetchImpl, plans: new TradePlanLedger(file) });
  const reloaded = new TradePlanLedger(file).get(fleetPlanId('ETHUSDT', T0));
  assert.equal(reloaded?.status, 'CLOSED');
  assert.equal(reloaded?.result, 'SL');
  assert.equal(reloaded?.pnl, -20);
});
