import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VenueUnavailableError } from '../src/binance/paperExchangeClient.js';
import { OllamaAdvisor, type AdvisorClient } from '../src/ollama/advisor.js';
import { OptionChainService, parseLevels } from '../src/options/OptionChainService.js';
import type { OptionVetoSnapshot } from '../src/options/types.js';
import { SdkUnderlyingContextSource, StaleContextError, type KlineReader } from '../src/options/UnderlyingContext.js';
import { LocalOptionsPaperVenue, MonitorOnlyVenue, PaperExchangeOptionsVenue } from '../src/options/venues.js';
import { EXPIRY, FakeOptionsMarket, rawSymbol, T0 } from './support/optionsFixture.js';

const fees = { rate: 0.0003, cap: 0.1 };
const contract = { symbol: 'BTC-261030-81000-C', underlying: 'BTCUSDT', right: 'CE' as const, strike: 81_000, expiryMs: EXPIRY, unit: 1, minQty: 0.01, qtyStep: 0.01, tickSize: 5 };

interface Call { method: string; url: string; body: any }
type Reply = { status: number; json?: unknown } | Error;

function scripted(replies: Reply[], calls: Call[]) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: String(init?.method), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { status: reply.status, text: async () => JSON.stringify(reply.json ?? '') } as Response;
  };
}

const venueWith = (replies: Reply[], calls: Call[]) =>
  new PaperExchangeOptionsVenue('http://pe:3000', 'crypto-options', fees, { fetchImpl: scripted(replies, calls), backoffMs: 1, retries: 0 });

test('paper_exchange buy sends a long-premium CRYPTO_OPTION order at the walked VWAP', async () => {
  const calls: Call[] = [];
  const venue = venueWith([{ status: 201, json: { id: 7, status: 'filled', quantity: '0.8', filled_quantity: '0.8' } }], calls);
  const result = await venue.buyToOpen({ contract, qty: 0.8, limitPrice: 1_300, book: [[1_250, 0.5], [1_280, 1]], indexPrice: 80_932, clientOrderId: 'opt-1' });

  assert.equal(calls[0].url, 'http://pe:3000/api/orders');
  assert.deepEqual(calls[0].body.order, {
    symbol: 'BTC-261030-81000-C', side: 'buy', quantity: 0.8, order_type: 'market', instrument_type: 'CRYPTO_OPTION',
    option_type: 'CE', strike_price: 81_000, expiry_date: '2026-10-30', leverage: 1,
    execution_price: (0.5 * 1_250 + 0.3 * 1_280) / 0.8, client_order_id: 'opt-1',
  });
  assert.equal(result.status, 'FILLED');
  assert.equal(result.filledQty, 0.8);
  assert.ok(Math.abs(result.avgPrice - 1_261.25) < 1e-9);
  assert.ok(Math.abs(result.fee - Math.min(0.0003 * 80_932 * 0.8, 0.1 * 1_261.25 * 0.8)) < 1e-9);
});

test('paper_exchange sell is reduce_only, and a book shortfall is reported as a partial fill', async () => {
  const calls: Call[] = [];
  const venue = venueWith([{ status: 201, json: { id: 8, status: 'filled', quantity: '0.4', filled_quantity: '0.4' } }], calls);
  const result = await venue.sellToClose({ contract, qty: 1, limitPrice: 900, book: [[950, 0.4], [800, 5]], indexPrice: 80_000, clientOrderId: 'opt-1-x1' });
  assert.equal(calls[0].body.order.reduce_only, true);
  assert.equal(calls[0].body.order.quantity, 0.4);
  assert.deepEqual([result.status, result.filledQty, result.avgPrice], ['PARTIALLY_FILLED', 0.4, 950]);
});

test('paper_exchange: a book with nothing inside the limit sends no order', async () => {
  const calls: Call[] = [];
  const result = await venueWith([{ status: 500 }], calls).buyToOpen({ contract, qty: 1, limitPrice: 1_000, book: [[1_200, 5]], indexPrice: 80_000, clientOrderId: 'x' });
  assert.equal(calls.length, 0);
  assert.equal(result.status, 'UNFILLED');
});

test('paper_exchange: a 4xx is a rejection, a transport failure is an unknown outcome', async () => {
  const rejected = await venueWith([{ status: 422, json: { error: 'CRYPTO_OPTION sell must be reduce_only' } }], []).buyToOpen({ contract, qty: 1, limitPrice: 1_300, book: [[1_250, 5]], indexPrice: 80_000, clientOrderId: 'r' });
  assert.equal(rejected.status, 'REJECTED');
  assert.match(rejected.reason ?? '', /422/);

  await assert.rejects(
    venueWith([new Error('ECONNRESET')], []).buyToOpen({ contract, qty: 1, limitPrice: 1_300, book: [[1_250, 5]], indexPrice: 80_000, clientOrderId: 'u' }),
    VenueUnavailableError,
  );
});

test('paper_exchange: findOrder walks the paginated envelope and positions keep only long options', async () => {
  const calls: Call[] = [];
  const venue = venueWith([
    { status: 200, json: { data: [{ client_order_id: 'other', status: 'filled' }], next_cursor: 'c1' } },
    { status: 200, json: { data: [{ client_order_id: 'opt-9', status: 'filled', quantity: '0.5', filled_quantity: '0.5' }], next_cursor: null } },
    { status: 200, json: [
      { symbol: 'BTC-261030-81000-C', instrument_type: 'CRYPTO_OPTION', side: 'long', net_quantity: '0.5', average_price: '1250' },
      { symbol: 'BTCUSDT', instrument_type: 'CRYPTO_PERPETUAL', side: 'long', net_quantity: '1', average_price: '80000' },
      { symbol: 'ETH-261030-2350-P', instrument_type: 'CRYPTO_OPTION', side: 'long', net_quantity: '0', average_price: '0' },
    ] },
  ], calls);
  const found = await venue.findOrder('opt-9');
  assert.deepEqual([found?.status, found?.filledQty], ['FILLED', 0.5]);
  assert.deepEqual(calls.map((c) => c.url), ['http://pe:3000/api/orders?limit=500', 'http://pe:3000/api/orders?limit=500&cursor=c1']);
  assert.deepEqual(await venue.positions(), [{ symbol: 'BTC-261030-81000-C', qty: 0.5, avgPrice: 1_250 }]);
});

test('paper_exchange: an account in another currency is refused', async () => {
  const account = (currency: string) => ({ status: 200, json: { account_id: 'a', currency, margin: 1_000, available_balance: 1_000, locked_margin: 0, equity: 1_000, unrealized_pnl: 0, realized_pnl: 0, positions_count: 0 } });
  await assert.rejects(venueWith([account('INR')], []).ensureAccount(1_000), /currency is INR/);
  await venueWith([account('USD')], []).ensureAccount(1_000);
});

test('the local venue is idempotent per order id and accounts cash exactly', async () => {
  const venue = new LocalOptionsPaperVenue(10_000, fees);
  const buy = { contract, qty: 2, limitPrice: 1_300, book: [[1_250, 5]] as Array<[number, number]>, indexPrice: 80_000, clientOrderId: 'b1' };
  const first = await venue.buyToOpen(buy);
  const replay = await venue.buyToOpen(buy);
  assert.deepEqual(replay, first);
  assert.deepEqual(await venue.positions(), [{ symbol: contract.symbol, qty: 2, avgPrice: 1_250 }]);
  assert.equal(await venue.equity(), 10_000 - 48); // marked at cost: only the fee is lost

  const tooBig = await venue.buyToOpen({ ...buy, qty: 10, book: [[1_250, 50]], clientOrderId: 'b2' });
  assert.equal(tooBig.status, 'REJECTED');
  assert.match(tooBig.reason ?? '', /insufficient cash/);

  const noPos = await venue.sellToClose({ ...buy, contract: { ...contract, symbol: 'ETH-261030-2350-C' }, clientOrderId: 's0' });
  assert.equal(noPos.status, 'REJECTED');

  await venue.sellToClose({ ...buy, qty: 5, limitPrice: 1_000, book: [[1_400, 5]], clientOrderId: 's1' });
  assert.deepEqual(await venue.positions(), []);
  assert.equal(await venue.equity(), 10_000 - 48 + 2 * 150 - 24 * 2);
  const snapshot = venue.exportState();
  const restored = new LocalOptionsPaperVenue(1, fees);
  restored.importState(snapshot);
  assert.equal(await restored.equity(), await venue.equity());
  assert.deepEqual(await restored.findOrder('b1'), first);
  assert.throws(() => restored.importState({ cash: NaN, held: [], marks: [], orders: [] }), /malformed/);
});

test('the monitor venue cannot place orders', async () => {
  const venue = new MonitorOnlyVenue('coindcx-monitor', 1_000);
  assert.equal(venue.canExecute, false);
  await assert.rejects(venue.buyToOpen(), /monitor-only/);
  await assert.rejects(venue.sellToClose(), /monitor-only/);
});

// ---- chain + context ---------------------------------------------------------------------------------------------

test('the chain drops malformed book levels, sorts best first and reports refused contracts once loaded', async () => {
  assert.deepEqual(parseLevels([['10', '1'], ['abc', '1'], ['12', '0'], ['11', '2']], 'bids'), [[11, 2], [10, 1]]);
  assert.deepEqual(parseLevels([['12', '1'], ['11', '2']], 'asks'), [[11, 2], [12, 1]]);

  const market = new FakeOptionsMarket(() => T0);
  market.symbols.push(rawSymbol('BTC-261030-85000-C', { unit: undefined }));
  const refused: string[] = [];
  const chain = new OptionChainService(market, { now: () => T0, onRejectedContract: (s, r) => refused.push(`${s}: ${r}`) });
  assert.equal((await chain.contractsFor('BTCUSDT')).length, 3);
  assert.equal((await chain.contractsFor('ETHUSDT')).length, 0);
  assert.deepEqual(refused, ['BTC-261030-85000-C: no contract unit']);
});

const klines = (count: number, frameMs: number, endOpen: number) =>
  Array.from({ length: count }, (_, i) => {
    const openTime = endOpen - (count - 1 - i) * frameMs;
    const close = 80_000 + Math.sin(i / 5) * 400 + i * 2;
    return { openTime, open: close - 10, high: close + 30, low: close - 30, close, volume: 10 };
  });

test('the binance-sdk context source drops the forming bar and refuses a stale feed', async () => {
  const now = T0;
  const frames = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const;
  let lag = 0;
  const reader: KlineReader = {
    klines: async (_symbol, interval) => {
      const f = frames[interval];
      const forming = Math.floor((now - lag) / f) * f;
      return klines(interval === '4h' ? 200 : 300, f, forming);
    },
  };
  const source = new SdkUnderlyingContextSource(reader, undefined, () => now);
  const ctx = await source.context('BTCUSDT');
  assert.equal(ctx.lastClosedAt, Math.floor(now / 900_000) * 900_000);
  assert.ok(ctx.candles1h.every((c) => c.openTime + 3_600_000 <= now));
  assert.equal(ctx.marketState.symbol, 'BTCUSDT');

  lag = 60 * 60_000;
  await assert.rejects(source.context('BTCUSDT'), StaleContextError);
});

// ---- LLM veto ----------------------------------------------------------------------------------------------------

const snapshot: OptionVetoSnapshot = {
  underlying: 'BTCUSDT', contract: 'BTC-261030-80000-C', right: 'CE', spot: 80_000, strike: 80_000, hoursToExpiry: 123.3,
  premium: 1_908, spreadPct: 1.6, delta: 0.53, thetaPerDay: -190, impliedVolPct: 50, realizedVolPct: 45, ivRvRatio: 1.11,
  breakevenMovePct: 0.17, edgeRatio: 7.2, regime: 'TREND_UP', htfTrend: 'BULLISH', rsi15m: 58, stopPremium: 1_335,
  targetPremium: 3_053, quantity: 1.01, maxLossUsdt: 640,
};

test('the option veto proceeds when Ollama is offline, vetoes on an unparseable reply, and sees only the snapshot', async () => {
  const offline: AdvisorClient = { listModels: async () => { throw new Error('down'); }, generateText: async () => '' };
  const off = new OllamaAdvisor(offline);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await off.vetoOption(snapshot), { verdict: 'PROCEED', reason: 'advisor offline' });

  const prompts: string[] = [];
  const garbled: AdvisorClient = { listModels: async () => ({}), generateText: async (r) => { prompts.push(r.prompt); return 'buy it!'; } };
  const advisor = new OllamaAdvisor(garbled);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await advisor.vetoOption(snapshot)).verdict, 'VETO');
  assert.match(prompts[0], /LONG crypto option purchase \(buying a call/);
  assert.ok(prompts[0].includes(JSON.stringify(snapshot)));

  const veto: AdvisorClient = { listModels: async () => ({}), generateText: async () => '{"verdict":"VETO","reason":"IV rich"}' };
  const v = new OllamaAdvisor(veto);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await v.vetoOption(snapshot), { verdict: 'VETO', reason: 'IV rich' });
});
