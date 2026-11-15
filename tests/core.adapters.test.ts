import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BinanceMarketDataAdapter, type BinancePublicSource } from '../src/core/adapters/binance/BinanceMarketDataAdapter.js';
import { withExecutionLogging } from '../src/core/adapters/decorators/execution.js';
import { CachingMarketData, MeteredMarketData, RetryingMarketData } from '../src/core/adapters/decorators/marketData.js';
import { OllamaAdvisorAdapter, type AdvisorTextClient } from '../src/core/adapters/ollama/OllamaAdvisorAdapter.js';
import { PaperExchangeApi } from '../src/core/adapters/paper-exchange/PaperExchangeApi.js';
import { PaperExchangeExecutionAdapter } from '../src/core/adapters/paper-exchange/PaperExchangeExecutionAdapter.js';
import { PaperExchangePortfolioAdapter } from '../src/core/adapters/paper-exchange/PaperExchangePortfolioAdapter.js';
import { JsonlResearchRepository } from '../src/core/adapters/persistence/JsonlResearchRepository.js';
import { JsonStateStore } from '../src/core/adapters/persistence/JsonStateStore.js';
import { MarkPricePump } from '../src/core/application/engine/MarkPricePump.js';
import { BarCloseSource } from '../src/core/application/engine/BarCloseSource.js';
import type { PlaceOrderCommand } from '../src/core/domain/execution.js';
import type { BarClosedEvent, Candle } from '../src/core/domain/market.js';
import type { TradingEvent } from '../src/core/events/TradingEvent.js';
import { TradingEventBus } from '../src/core/events/TradingEventBus.js';
import type { AdvisorBrief } from '../src/core/ports/DecisionAdvisorPort.js';
import { MarketDataError, type MarketDataPort } from '../src/core/ports/MarketDataPort.js';
import { VenueRejectedError, VenueUnavailableError } from '../src/core/ports/PaperExecutionPort.js';
import { candlesFromCloses, FakeExecution, FakeMarketData, FakePaperExchange, flat, snapshotOf, T0 } from './support/coreFixtures.js';

const FRAME = 900_000;
const COMMAND: PlaceOrderCommand = Object.freeze({
  commandId: 'cmd_1', idempotencyKey: 'pc-abc', decisionId: 'dec_1', strategyId: 's', strategyVersion: '1.0.0', symbol: 'BTCUSDT', side: 'BUY',
  quantity: 0.5, orderType: 'MARKET', leverage: 3, referencePrice: 100, stopLoss: 98, takeProfit: 106, createdAt: T0,
});

function binanceSource(candles: Candle[], overrides: Partial<BinancePublicSource> = {}): BinancePublicSource & { klineCalls: unknown[] } {
  const klineCalls: unknown[] = [];
  return {
    klineCalls,
    klines: async (_symbol, _interval, options) => {
      klineCalls.push(options);
      return candles.filter((c) => (options.startTime === undefined || c.openTime >= options.startTime) && (options.endTime === undefined || c.openTime <= options.endTime)).slice(-(options.limit ?? 500));
    },
    premiumIndex: async () => ({ markPrice: 100.25, lastFundingRate: 0.0001, nextFundingTime: T0 + 8 * 3_600_000, time: T0 + 5 * FRAME + 1_500 }),
    openInterest: async () => ({ openInterest: 12_345 }),
    ...overrides,
  };
}

// --- Binance market data ------------------------------------------------------------------------------------------

test('binance: the snapshot holds closed bars only and maps mark, funding and open interest', async () => {
  const candles = candlesFromCloses([100, 101, 102, 103, 104, 105, 106]); // the last two had not closed at asOf
  const source = binanceSource(candles);
  const snapshot = await new BinanceMarketDataAdapter(source).getSnapshot({ symbol: 'BTCUSDT', timeframes: ['15m'], bars: 3, asOf: T0 + 5 * FRAME });
  assert.deepEqual(snapshot.candles['15m']!.map((c) => c.close), [102, 103, 104]);
  assert.equal(snapshot.candles['15m']!.at(-1)!.openTime + FRAME, snapshot.asOf);
  assert.deepEqual([snapshot.markPrice, snapshot.markAt, snapshot.fundingRate, snapshot.openInterest], [100.25, T0 + 5 * FRAME + 1_500, 0.0001, 12_345]);
  // One extra row is requested so a still-forming newest row can be dropped
  assert.deepEqual(source.klineCalls, [{ endTime: T0 + 5 * FRAME - 1, limit: 4 }]);
});

test('binance: open interest is optional, the mark is not', async () => {
  const candles = candlesFromCloses(flat(6, 100));
  const request = { symbol: 'BTCUSDT', timeframes: ['15m' as const], bars: 3, asOf: T0 + 5 * FRAME };
  const noOi = await new BinanceMarketDataAdapter(binanceSource(candles, { openInterest: async () => { throw new Error('429'); } })).getSnapshot(request);
  assert.equal(noOi.openInterest, null);
  await assert.rejects(() => new BinanceMarketDataAdapter(binanceSource(candles, { premiumIndex: async () => { throw new Error('ECONNRESET'); } })).getSnapshot(request), (e: Error) => e instanceof MarketDataError && /ECONNRESET/.test(e.message));
  await assert.rejects(() => new BinanceMarketDataAdapter(binanceSource(candles, { premiumIndex: async () => ({ markPrice: 0, lastFundingRate: 0, nextFundingTime: 0, time: T0 }) })).getSnapshot(request), /mark price 0 is not usable/);
});

test('binance: a gap or a malformed bar is an error, not data', async () => {
  const candles = candlesFromCloses(flat(6, 100));
  const request = { symbol: 'BTCUSDT', timeframes: ['15m' as const], bars: 5, asOf: T0 + 6 * FRAME };
  const gapped = candles.filter((_, i) => i !== 3);
  await assert.rejects(() => new BinanceMarketDataAdapter(binanceSource(gapped)).getSnapshot(request), (e: Error) => e instanceof MarketDataError && /gap between bars/.test(e.message));
  const broken = candles.map((c, i) => (i === 4 ? { ...c, high: Number.NaN } : c));
  await assert.rejects(() => new BinanceMarketDataAdapter(binanceSource(broken)).getSnapshot(request), /high is not a positive finite number/);
});

test('binance: history is paginated without duplicates, and marks skip symbols that fail', async () => {
  const candles = candlesFromCloses(flat(3200, 100));
  const source = binanceSource(candles, {
    klines: async (_s, _i, options) => candles.filter((c) => c.openTime >= options.startTime! && c.openTime <= options.endTime!).slice(0, options.limit),
  });
  const adapter = new BinanceMarketDataAdapter(source);
  const history = await adapter.getCandles('BTCUSDT', '15m', T0 + 10 * FRAME, T0 + 3100 * FRAME);
  assert.equal(history.length, 3090);
  assert.equal(history[0].openTime, T0 + 10 * FRAME);
  assert.equal(history.at(-1)!.openTime, T0 + 3099 * FRAME);
  assert.ok(history.every((c, i) => i === 0 || c.openTime - history[i - 1].openTime === FRAME));

  const marks = await new BinanceMarketDataAdapter(binanceSource(candles, {
    premiumIndex: async (symbol) => { if (symbol === 'ETHUSDT') throw new Error('down'); return { markPrice: 7, lastFundingRate: 0.0002, nextFundingTime: 99, time: 5 }; },
  })).getMarks(['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(marks, [{ symbol: 'BTCUSDT', markPrice: 7, fundingRate: 0.0002, nextFundingTime: 99, observedAt: 5 }]);
});

// --- PaperExchange ------------------------------------------------------------------------------------------------

const paper = (retries = 0) => {
  const server = new FakePaperExchange();
  const api = new PaperExchangeApi('http://paper.test', 'acct', { fetchImpl: server.fetch, apiKey: 'op-key', retries, backoffMs: 1 });
  return { server, api, execution: new PaperExchangeExecutionAdapter(api), portfolio: new PaperExchangePortfolioAdapter(api) };
};

test('paper_exchange: an order is a market order at the reference price with the idempotency key as client order id', async () => {
  const { server, execution } = paper();
  const ack = await execution.submitOrder(COMMAND);
  assert.deepEqual([ack.status, ack.filledQuantity, ack.protectionCarried], ['FILLED', 0.5, false]);
  const request = server.requests.find((r) => r.method === 'POST' && r.path === '/api/orders')!;
  assert.deepEqual(request.body, { order: {
    symbol: 'BTCUSDT', side: 'buy', quantity: 0.5, order_type: 'market', instrument_type: 'CRYPTO_PERPETUAL', leverage: 3, margin_type: 'isolated',
    execution_price: 100, client_order_id: 'pc-abc',
  } });
  assert.deepEqual([request.accountId, request.apiKey], ['acct', 'op-key']);
  // Resubmitting the same command replays the original order
  await execution.submitOrder(COMMAND);
  assert.equal(server.live.orders.length, 1);
  assert.equal(server.live.positions.length, 1);
});

test('paper_exchange: protection creates the missing stop and target once', async () => {
  const { server, execution, portfolio } = paper();
  await execution.submitOrder(COMMAND);
  await execution.protect(COMMAND);
  await execution.protect(COMMAND);
  const [position] = server.live.positions;
  assert.deepEqual(server.live.protections.get(position.id)!.map((p) => [p.protection_type, p.trigger_price, p.quantity]), [['stop_loss', 98, 0.5], ['take_profit', 106, 0.5]]);
  const account = await portfolio.getAccount(T0);
  assert.deepEqual(account.positions.map((p) => [p.symbol, p.direction, p.quantity, p.stopLoss]), [['BTCUSDT', 'LONG', 0.5, 98]]);
  assert.deepEqual([account.equity, account.availableMargin, account.realizedPnl, account.asOf], [10_000, 10_000, 0, T0]);
});

test('paper_exchange: protecting a position that does not exist is refused, and an unprotected position reports no stop', async () => {
  const { execution, portfolio } = paper();
  await assert.rejects(() => execution.protect(COMMAND), (e: Error) => e instanceof VenueRejectedError && /no open BTCUSDT position/.test(e.message));
  await execution.submitOrder(COMMAND);
  assert.equal((await portfolio.getAccount(T0)).positions[0].stopLoss, null);
});

test('paper_exchange: flatten closes the whole position reduce-only, and is a no-op without one', async () => {
  const { server, execution } = paper();
  await execution.flatten(COMMAND, 'test');
  assert.equal(server.count('POST', /\/api\/orders$/), 0);
  await execution.submitOrder(COMMAND);
  await execution.flatten(COMMAND, 'protection failed');
  const close = server.requests.filter((r) => r.method === 'POST' && r.path === '/api/orders').at(-1)!;
  assert.deepEqual([close.body.order.side, close.body.order.quantity, close.body.order.reduce_only, close.body.order.client_order_id], ['sell', 0.5, true, 'pc-abc-flat']);
  assert.equal(server.live.positions.length, 0);
});

test('paper_exchange: 4xx is a rejection, 5xx and network errors are an unknown outcome', async () => {
  const { server, execution, portfolio } = paper();
  server.failNext(/POST \/api\/orders/, 422);
  await assert.rejects(() => execution.submitOrder(COMMAND), VenueRejectedError);
  server.failNext(/POST \/api\/orders/, 503);
  await assert.rejects(() => execution.submitOrder(COMMAND), VenueUnavailableError);
  server.failNext(/POST \/api\/orders/, new TypeError('fetch failed'));
  await assert.rejects(() => execution.submitOrder(COMMAND), VenueUnavailableError);
  server.failNext(/GET \/api\/account/, 500);
  await assert.rejects(() => portfolio.getAccount(T0), VenueUnavailableError);
  server.live.account = null;
  await assert.rejects(() => portfolio.getAccount(T0), /no account for the configured account id/);
});

test('paper_exchange: findOrder recovers a submission whose answer was lost', async () => {
  const { server, execution } = paper();
  assert.equal(await execution.findOrder('pc-abc'), null);
  await execution.submitOrder(COMMAND);
  const found = await execution.findOrder('pc-abc');
  assert.deepEqual([found?.status, found?.filledQuantity], ['FILLED', 0.5]);
  server.live.orders[0].status = 'rejected';
  await assert.rejects(() => execution.findOrder('pc-abc'), VenueRejectedError);
  server.live.orders[0].status = 'open';
  await assert.rejects(() => execution.findOrder('pc-abc'), VenueUnavailableError);
});

/** Reshapes the fake venue's JSON replies for requests matching `method path`, simulating broker responses the real one must never send. */
function reshapedFetch(inner: typeof fetch, match: RegExp, rewrite: (body: any) => unknown): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!match.test(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)) return res;
    return new Response(JSON.stringify(rewrite(await res.json())), { status: res.status });
  };
}

const executionOver = (fetchImpl: typeof fetch) =>
  new PaperExchangeExecutionAdapter(new PaperExchangeApi('http://paper.test', 'acct', { fetchImpl, apiKey: 'op-key', retries: 0, backoffMs: 1 }));

test('paper_exchange: a filled ack without a usable filled_quantity is an unknown outcome, never the requested quantity', async () => {
  const { server } = paper();
  const execution = executionOver(reshapedFetch(server.fetch, /^POST \/api\/orders$/, ({ filled_quantity, ...row }) => row));
  await assert.rejects(() => execution.submitOrder(COMMAND), (e: Error) => e instanceof VenueUnavailableError && /without a usable filled_quantity/.test(e.message));
  // The order landed anyway: only reconciliation through findOrder can resolve what filled
  assert.equal(server.live.positions.length, 1);
  // A zero or non-numeric fill is equally unusable
  const zero = executionOver(reshapedFetch(server.fetch, /^POST \/api\/orders$/, (row) => ({ ...row, filled_quantity: 0 })));
  const cmd = { ...COMMAND, idempotencyKey: 'pc-zero' };
  await assert.rejects(() => zero.submitOrder(cmd), /without a usable filled_quantity/);
  const asString = executionOver(reshapedFetch(server.fetch, /^POST \/api\/orders$/, (row) => ({ ...row, filled_quantity: 'garbage' })));
  await assert.rejects(() => asString.submitOrder({ ...COMMAND, idempotencyKey: 'pc-str' }), /without a usable filled_quantity/);
});

test('paper_exchange: an over-filling ack is an unknown outcome, not an accepted fill', async () => {
  const { server } = paper();
  const execution = executionOver(reshapedFetch(server.fetch, /^POST \/api\/orders$/, (row) => ({ ...row, filled_quantity: 9 })));
  await assert.rejects(() => execution.submitOrder(COMMAND), (e: Error) => e instanceof VenueUnavailableError && /reports fill 9 against a request of 0\.5/.test(e.message));
});

test('paper_exchange: an ack echoing a different client_order_id is an unknown outcome', async () => {
  const { server } = paper();
  const execution = executionOver(reshapedFetch(server.fetch, /^POST \/api\/orders$/, (row) => ({ ...row, client_order_id: 'some-other-key' })));
  await assert.rejects(() => execution.submitOrder(COMMAND), (e: Error) => e instanceof VenueUnavailableError && /carries client_order_id some-other-key, not pc-abc/.test(e.message));
});

test('paper_exchange: findOrder reports an unusable fill instead of fabricating zero', async () => {
  const { server, execution } = paper();
  await execution.submitOrder(COMMAND);
  const finder = executionOver(reshapedFetch(server.fetch, /^GET \/api\/orders$/, (envelope) => ({
    ...envelope, data: envelope.data.map(({ filled_quantity, ...row }: { filled_quantity?: number }) => row),
  })));
  await assert.rejects(() => finder.findOrder('pc-abc'), (e: Error) => e instanceof VenueUnavailableError && /without a usable filled_quantity/.test(e.message));
});

test('paper_exchange: a partial fill with a usable quantity maps through unchanged', async () => {
  const { server } = paper();
  const execution = executionOver(reshapedFetch(server.fetch, /^POST \/api\/orders$/, (row) => ({ ...row, status: 'partially_filled', filled_quantity: 0.2 })));
  const ack = await execution.submitOrder(COMMAND);
  assert.deepEqual([ack.status, ack.filledQuantity], ['PARTIALLY_FILLED', 0.2]);
});

test('paper_exchange: marks and funding are pushed in the broker format', async () => {
  const { server, execution } = paper();
  await execution.pushMarks({ BTCUSDT: 101, ETHUSDT: 51 });
  await execution.pushFunding('BTCUSDT', 0.0001, 101, T0);
  assert.deepEqual(server.live.marks, [{ BTCUSDT: 101, ETHUSDT: 51 }]);
  assert.deepEqual(server.live.funding, [{ symbol: 'BTCUSDT', funding_rate: 0.0001, mark_price: 101, funding_time: new Date(T0).toISOString() }]);
});

// --- Mark pump and bar source -------------------------------------------------------------------------------------

test('the mark pump pushes marks every tick and each funding settlement exactly once', async () => {
  const pushed: unknown[] = [];
  let now = T0, next = T0 + 1000;
  const errors: unknown[] = [];
  const pump = new MarkPricePump({
    symbols: ['BTCUSDT'], intervalMs: 5000, clock: { now: () => now }, onError: (e) => errors.push(e),
    source: { getMarks: async () => [{ symbol: 'BTCUSDT', markPrice: 100, fundingRate: 0.0003, nextFundingTime: next, observedAt: now }] },
    sink: { pushMarks: async (marks) => { pushed.push(['marks', marks]); }, pushFunding: async (...args) => { pushed.push(['funding', ...args]); } },
  });
  await pump.tick();
  now = T0 + 900; await pump.tick(); // before the settlement
  now = T0 + 1100; next = T0 + 8 * 3_600_000; await pump.tick(); // the venue now shows the next settlement
  await pump.tick();
  assert.equal(pushed.filter((p) => (p as unknown[])[0] === 'marks').length, 4);
  assert.deepEqual(pushed.filter((p) => (p as unknown[])[0] === 'funding'), [['funding', 'BTCUSDT', 0.0003, 100, T0 + 1000]]);
  assert.deepEqual(errors, []);
});

test('the mark pump reports a failure and keeps running; an unusable mark is not pushed', async () => {
  const errors: unknown[] = [], pushed: unknown[] = [];
  let fail = true;
  const pump = new MarkPricePump({
    symbols: ['BTCUSDT'], intervalMs: 5000, clock: { now: () => T0 }, onError: (e) => errors.push(e),
    source: { getMarks: async () => { if (fail) throw new Error('binance down'); return [{ symbol: 'BTCUSDT', markPrice: Number.NaN, fundingRate: 0, nextFundingTime: 0, observedAt: T0 }]; } },
    sink: { pushMarks: async (m) => { pushed.push(m); }, pushFunding: async () => undefined },
  });
  await pump.tick();
  fail = false;
  await pump.tick();
  assert.equal(errors.length, 1);
  assert.deepEqual(pushed, []);
});

test('the bar source emits the bar that just closed and refuses a feed that has not caught up', async () => {
  const candles = candlesFromCloses(flat(10, 100));
  const events: BarClosedEvent[] = [], errors: string[] = [];
  const source = new BarCloseSource({
    symbols: ['BTCUSDT'], timeframe: '15m', settleMs: 2000, marketData: new FakeMarketData({ BTCUSDT: candles }), clock: { now: () => T0 },
    onEvent: (e) => events.push(e), onError: (e, symbol) => errors.push(`${symbol}: ${(e as Error).message}`),
  });
  await source.poll(T0 + 10 * FRAME);
  assert.deepEqual(events.map((e) => [e.eventId, e.closedAt]), [[`BTCUSDT:15m:${T0 + 9 * FRAME}`, T0 + 10 * FRAME]]);
  await source.poll(T0 + 11 * FRAME); // the feed's newest closed bar is still the previous one
  assert.equal(events.length, 1);
  assert.match(errors[0], /BTCUSDT: expected the bar opened at/);
});

test('the bar source schedules itself just after the next boundary', () => {
  const delays: number[] = [];
  const source = new BarCloseSource({
    symbols: ['BTCUSDT'], timeframe: '15m', settleMs: 2000, marketData: new FakeMarketData({}), clock: { now: () => T0 + 60_000 },
    onEvent: () => undefined, onError: () => undefined, setTimer: (_fn, ms) => { delays.push(ms); return 1; }, clearTimer: () => undefined,
  });
  source.start();
  source.start();
  source.stop();
  assert.deepEqual(delays, [FRAME - 60_000 + 2000]);
});

// --- Ollama advisor -----------------------------------------------------------------------------------------------

const BRIEF: AdvisorBrief = { decisionId: 'dec_1', symbol: 'BTCUSDT', direction: 'LONG', strategyId: 's', reason: 'r', entry: 100, stopLoss: 98, takeProfit: 106, rewardRisk: 3, fundingRate: 0.0001 };
const advisor = (client: AdvisorTextClient, host = 'http://127.0.0.1:11434') => new OllamaAdvisorAdapter(client, { host, model: 'gemma', timeoutMs: 50 });

test('ollama: a well-formed reply is returned as the verdict; a fenced one is still parsed', async () => {
  const requests: unknown[] = [];
  const client: AdvisorTextClient = { generateText: async (request) => { requests.push(request); return '```json\n{"verdict":"VETO","reason":"funding crowded"}\n```'; } };
  assert.deepEqual(await advisor(client).review(BRIEF), { verdict: 'VETO', reason: 'funding crowded', model: 'gemma' });
  assert.deepEqual(await advisor({ generateText: async () => '{"verdict":"PROCEED","reason":"fine"}' }).review(BRIEF), { verdict: 'PROCEED', reason: 'fine', model: 'gemma' });
  const sent = requests[0] as { model: string; prompt: string; format?: string };
  assert.equal(sent.model, 'gemma');
  assert.equal(sent.format, 'json'); // JSON mode is requested from a local daemon
  assert.ok(sent.prompt.includes('"decisionId":"dec_1"'));
  // Against Ollama Cloud the SDK refuses `format`, so it is not sent
  const cloud: unknown[] = [];
  await advisor({ generateText: async (r) => { cloud.push(r); return '{"verdict":"PROCEED","reason":"ok"}'; } }, 'https://ollama.com').review(BRIEF);
  assert.ok(!('format' in (cloud[0] as object)));
});

test('ollama: no answer is UNAVAILABLE; an answer that breaks the contract is a VETO', async () => {
  const unavailable = [
    advisor({ generateText: async () => { throw new Error('ECONNREFUSED'); } }),
    advisor({ generateText: () => new Promise(() => undefined) }),
  ];
  for (const a of unavailable) assert.equal((await a.review(BRIEF)).verdict, 'UNAVAILABLE');
  for (const reply of ['I think this looks good!', '{"verdict":"MAYBE","reason":"x"}', '{"verdict":"PROCEED"}', '{"verdict":"PROCEED","reason":"ok","quantity":5}'.replace('"PROCEED"', '"proceed"')]) {
    const opinion = await advisor({ generateText: async () => reply }).review(BRIEF);
    assert.deepEqual([opinion.verdict, opinion.reason], ['VETO', 'advisor sent a reply that does not match the contract'], reply);
  }
});

test('ollama: extra fields in a reply are dropped; the opinion carries a verdict and a reason only', async () => {
  const opinion = await advisor({ generateText: async () => '{"verdict":"PROCEED","reason":"ok","quantity":50,"leverage":125,"stopLoss":1}' }).review(BRIEF);
  assert.deepEqual(opinion, { verdict: 'PROCEED', reason: 'ok', model: 'gemma' });
});

// --- Decorators ---------------------------------------------------------------------------------------------------

test('decorators: caching serves the same instant once, never caches a failure, and keys on asOf', async () => {
  let calls = 0, fail = false;
  const inner: MarketDataPort = { getSnapshot: async (r) => { calls += 1; if (fail) throw new MarketDataError('down'); return snapshotOf(r.symbol, candlesFromCloses([100, 100])); } };
  const cached = new CachingMarketData(inner);
  const request = { symbol: 'BTCUSDT', timeframes: ['15m' as const], bars: 5, asOf: T0 };
  const [a, b] = await Promise.all([cached.getSnapshot(request), cached.getSnapshot(request)]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  await cached.getSnapshot({ ...request, asOf: T0 + 1 });
  assert.equal(calls, 2);
  fail = true;
  await assert.rejects(() => cached.getSnapshot({ ...request, asOf: T0 + 2 }));
  fail = false;
  await cached.getSnapshot({ ...request, asOf: T0 + 2 });
  assert.equal(calls, 4);
});

test('decorators: retry backs off exponentially and gives up with the last error; metrics count calls and failures', async () => {
  let failures = 2;
  const sleeps: number[] = [];
  const inner: MarketDataPort = { getSnapshot: async (r) => { if (failures-- > 0) throw new MarketDataError(`down ${failures}`); return snapshotOf(r.symbol, candlesFromCloses([100, 100])); } };
  const metered = new MeteredMarketData(inner, () => 0);
  const retrying = new RetryingMarketData(metered, { attempts: 3, backoffMs: 100, sleep: async (ms) => { sleeps.push(ms); } });
  const request = { symbol: 'BTCUSDT', timeframes: ['15m' as const], bars: 5, asOf: T0 };
  assert.equal((await retrying.getSnapshot(request)).symbol, 'BTCUSDT');
  assert.deepEqual(sleeps, [100, 200]);
  assert.deepEqual([metered.metrics.calls, metered.metrics.failures], [3, 2]);
  failures = 99;
  await assert.rejects(() => retrying.getSnapshot(request), /down/);
  assert.equal(metered.metrics.calls, 6);
  assert.throws(() => new RetryingMarketData(inner, { attempts: 0, backoffMs: 1 }), /attempts/);
});

test('decorators: execution logging records each call and never retries a failed submission', async () => {
  const venue = new FakeExecution();
  venue.submitScript = [new VenueUnavailableError('timeout')];
  const lines: Array<{ op: string; outcome: string }> = [];
  const logged = withExecutionLogging(venue, (line) => lines.push(line), () => 0);
  assert.equal(logged.venue, 'paper_exchange');
  await assert.rejects(() => logged.submitOrder(COMMAND), VenueUnavailableError);
  assert.equal(venue.submitted.length, 1);
  await logged.findOrder('pc-abc');
  await logged.protect(COMMAND);
  await logged.flatten(COMMAND, 'why');
  assert.deepEqual(lines.map((l) => [l.op, l.outcome]), [['submitOrder', 'error: timeout'], ['findOrder', 'not found'], ['protect', 'attached'], ['flatten', 'flattened (why)']]);
});

// --- Persistence and events ---------------------------------------------------------------------------------------

test('the journal is append-only JSONL in publish order and survives a torn last line', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'core-journal-')), 'nested', 'events.jsonl');
  const journal = new JsonlResearchRepository(file);
  const bus = new TradingEventBus('run-1');
  bus.subscribe((event) => journal.append(event));
  bus.publish({ type: 'decision.none', symbol: 'BTCUSDT', reason: 'no signals' }, T0, 'evt-1');
  bus.publish({ type: 'engine.halted', reason: 'test' }, T0 + 1, 'evt-1');
  const read = journal.read();
  assert.deepEqual(read.map((e: TradingEvent) => [e.sequence, e.type, e.runId, e.causeEventId]), [[1, 'decision.none', 'run-1', 'evt-1'], [2, 'engine.halted', 'run-1', 'evt-1']]);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"type":"decision.no`);
  assert.equal(journal.read().length, 2);
  writeFileSync(file, 'not json\n{"a":1}\n');
  assert.throws(() => journal.read(), /line 1 is not valid JSON/);
  assert.deepEqual(new JsonlResearchRepository(path.join(path.dirname(file), 'missing.jsonl')).read(), []);
});

test('state is written atomically, and a corrupt file is an error rather than a fresh start', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'core-state-')), 'deep', 'state.json');
  const store = new JsonStateStore<{ breaker: string }>(file);
  assert.equal(store.load(), null);
  store.save({ breaker: 'TRIPPED' });
  assert.deepEqual(store.load(), { breaker: 'TRIPPED' });
  writeFileSync(file, '{"breaker":');
  assert.throws(() => store.load(), /unreadable/);
});
