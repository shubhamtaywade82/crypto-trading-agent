import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OrderRejectedError, type SubmitOrderParams } from '../src/binance/paperExchangeClient.js';
import { CoinDcxExchangeApi, type CoinDcxExchangeApiDeps, type CoinDcxOrderClient } from '../src/coindcx/coindcxClient.js';

function createMockClient(paperMode: boolean): CoinDcxOrderClient {
  return {
    paperMode,
    futures: {
      trading: {
        createOrder: async (req) => ({
          id: 'order-123',
          client_order_id: req.client_order_id,
          status: 'filled',
          filled_quantity: req.target_quantity,
          price: req.price,
        }),
        listOrders: async () => [],
      },
      account: {
        updateLeverage: async () => ({}),
        getPositions: async () => [],
        getWallet: async () => [{ currency: 'USDT', balance: 1000, locked_balance: 0, available_balance: 1000 }],
      },
      market: {
        getMarketsDetails: async () => [{ pair: 'B-BTC_USDT', status: 'active' }],
        getInstrumentDetails: async () => ({ lot_size: 0.001, min_quantity: 0.001, min_price: 1, max_leverage: 20 }),
      },
    },
    marketData: { getSpotTicker: async () => [] },
  };
}

function createApi(client: CoinDcxOrderClient, isLiveExecutionArmed = false): CoinDcxExchangeApi {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'coindcx-guard-'));
  const deps: CoinDcxExchangeApiDeps = {
    client,
    quotePreference: 'auto',
    baselinePath: path.join(tmpDir, 'baseline.json'),
    accountId: 'coindcx-test',
    isLiveExecutionArmed,
  };
  return new CoinDcxExchangeApi(deps);
}

const sampleOrder: SubmitOrderParams = {
  symbol: 'BTCUSDT',
  side: 'buy',
  quantity: 0.01,
  leverage: 5,
  executionPrice: 60_000,
  clientOrderId: 'guard-oid-1',
};

test('should reject live order when live execution is not armed and paper mode is off', async () => {
  const client = createMockClient(false);
  const api = createApi(client, false);

  await assert.rejects(
    async () => api.submitOrder(sampleOrder),
    (err: unknown) => {
      assert.ok(err instanceof OrderRejectedError);
      assert.match(err.message, /COINDCX READONLY GUARD/);
      assert.match(err.message, /COINDCX_LIVE_EXECUTION_ARMED is off/);
      return true;
    },
  );
});

test('should allow order when paper mode is active even if live execution is unarmed', async () => {
  const client = createMockClient(true);
  const api = createApi(client, false);

  const res = await api.submitOrder(sampleOrder);
  assert.equal(res.status, 'filled');
  assert.equal(res.orderId, 'order-123');
});

test('should allow order when live execution is explicitly armed on real account', async () => {
  const client = createMockClient(false);
  const api = createApi(client, true);

  const res = await api.submitOrder(sampleOrder);
  assert.equal(res.status, 'filled');
  assert.equal(res.orderId, 'order-123');
});
