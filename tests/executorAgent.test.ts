import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import { ExecutorAgent } from '../src/agents/ExecutorAgent.js';
import { config } from '../src/config.js';
import type { RiskDecision, Signal } from '../src/types.js';

const symbol = config.symbols[0];
const risk: RiskDecision = { approved: true, positionSizeUsdt: 1000, leverage: 5, marginType: 'ISOLATED', liqBufferAtr: 3, reason: '' };

function signal(overrides: Partial<Signal>): Signal {
  return { id: 's', agent: 'ADAPTIVE-ST-ζ', symbol, type: 'OPEN_LONG', confidence: 0.75, reason: '', ts: 0, ...overrides };
}

function stubService() {
  const captured: Record<string, unknown>[] = [];
  const service = {
    openFuturesPosition: async (params: Record<string, unknown>) => { captured.push(params); return { orderId: 1, status: 'FILLED' }; },
    getPremiumIndex: async () => ({ markPrice: 250, fundingRate: 0 }),
  } as unknown as BinanceService;
  return { captured, executor: new ExecutorAgent(service) };
}

test('should round quantity down to the step and prices to the tick', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 1, tickSize: 0.05, stepSize: 0.1 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 100.03, stopLoss: 94.02, takeProfit: 112.49 }), risk);
  assert.equal(log.level, 'success');
  assert.deepEqual(
    { qty: captured[0].qty, entryPrice: captured[0].entryPrice, stopLoss: captured[0].stopLoss, takeProfit: captured[0].takeProfit, strategy: captured[0].strategy },
    { qty: 9.9, entryPrice: 100.05, stopLoss: 94, takeProfit: 112.5, strategy: 'ADAPTIVE-ST-ζ' },
  );
});

test('should size a funding hedge off the live mark and short it', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001 });
  const { captured, executor } = stubService();
  await executor.execute(signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α' }), risk);
  assert.equal(captured[0].side, 'SELL');
  assert.equal(captured[0].qty, 4);
});

test('should refuse symbols outside config.symbols', async () => {
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ symbol: 'BTCUSDTETHUSDT', entry: 30 }), risk);
  assert.equal(log.level, 'error');
  assert.equal(captured.length, 0);
});

test('should refuse an order smaller than one lot', async () => {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 0, tickSize: 0.01, stepSize: 1 });
  const { captured, executor } = stubService();
  const log = await executor.execute(signal({ entry: 5000 }), risk);
  assert.equal(log.level, 'error');
  assert.equal(captured.length, 0);
});
