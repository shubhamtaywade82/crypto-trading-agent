import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStreamFrame, streamNames } from '../src/market/public/frameHandlers.js';
import { parseFinite, parsePositive } from '../src/market/public/parsers.js';
import { PublicQuoteStore } from '../src/market/public/PublicQuoteStore.js';
import { PublicRestClient } from '../src/market/public/PublicRestClient.js';
import { UsdmPublicClient } from '../src/market/public/UsdmPublicClient.js';
import { SpotPublicClient } from '../src/market/spot/SpotPublicClient.js';

const T0 = 1_800_000_000_000;

// ---- parsing: a bad number is null, never zero ----

test('parsePositive accepts decimal strings and rejects zero, negatives, NaN and junk as null', () => {
  assert.equal(parsePositive('61012.68000000'), 61012.68);
  assert.equal(parsePositive('0'), null);
  assert.equal(parsePositive('-1'), null);
  assert.equal(parsePositive('abc'), null);
  assert.equal(parsePositive(undefined), null);
  assert.equal(parsePositive(''), null);
});

test('parseFinite keeps a negative funding rate and still rejects junk', () => {
  assert.equal(parseFinite('-0.00012'), -0.00012);
  assert.equal(parseFinite('0'), 0);
  assert.equal(parseFinite('NaN'), null);
  assert.equal(parseFinite(null), null);
});

// ---- store: freshness, validation, basis ----

test('a symbol that never produced a book reads MISSING with null fields, not zero', () => {
  const store = new PublicQuoteStore(15_000);
  const q = store.quote('SPOT', 'BTCUSDT', T0);
  assert.equal(q.quality, 'MISSING');
  assert.equal(q.bid, null);
  assert.equal(q.ask, null);
  assert.equal(q.mid, null);
  assert.equal(q.last, null);
});

test('a book inside the staleness window is LIVE; past it, STALE with the last values kept', () => {
  const store = new PublicQuoteStore(15_000);
  store.applyBook('SPOT', 'BTCUSDT', 100, 101, T0);
  assert.equal(store.quote('SPOT', 'BTCUSDT', T0 + 14_999).quality, 'LIVE');
  const stale = store.quote('SPOT', 'BTCUSDT', T0 + 15_001);
  assert.equal(stale.quality, 'STALE');
  assert.equal(stale.bid, 100, 'the last known book is still reported, marked stale');
});

test('mid is the average of bid and ask, and last comes from the trade stream independently of book freshness', () => {
  const store = new PublicQuoteStore(15_000);
  store.applyBook('SPOT', 'BTCUSDT', 100, 102, T0);
  store.applyTrade('SPOT', 'BTCUSDT', 101.5, T0 + 1);
  const q = store.quote('SPOT', 'BTCUSDT', T0 + 60_000);
  assert.equal(q.mid, 101);
  assert.equal(q.last, 101.5);
  assert.equal(q.quality, 'STALE');
});

test('a crossed, zero, negative or non-finite book is rejected and the previous good book is kept', () => {
  const store = new PublicQuoteStore(15_000);
  assert.equal(store.applyBook('SPOT', 'BTCUSDT', 100, 101, T0), true);
  assert.equal(store.applyBook('SPOT', 'BTCUSDT', 102, 101, T0 + 1), false, 'crossed');
  assert.equal(store.applyBook('SPOT', 'BTCUSDT', 0, 101, T0 + 1), false, 'zero bid');
  assert.equal(store.applyBook('SPOT', 'BTCUSDT', -1, 101, T0 + 1), false, 'negative bid');
  assert.equal(store.applyBook('SPOT', 'BTCUSDT', null, 101, T0 + 1), false, 'missing bid');
  assert.equal(store.applyBook('SPOT', 'BTCUSDT', 100, 101, Number.NaN), false, 'bad timestamp');
  assert.equal(store.quote('SPOT', 'BTCUSDT', T0 + 2).bid, 100);
});

test('venues do not share books: a USDM book does not make a SPOT quote live', () => {
  const store = new PublicQuoteStore(15_000);
  store.applyBook('USDM', 'BTCUSDT', 100, 101, T0);
  assert.equal(store.quote('SPOT', 'BTCUSDT', T0).quality, 'MISSING');
  assert.equal(store.quote('USDM', 'BTCUSDT', T0).quality, 'LIVE');
});

test('basis is in basis points and only computed when both books are LIVE', () => {
  const store = new PublicQuoteStore(15_000);
  store.applyBook('SPOT', 'BTCUSDT', 100.00, 100.02, T0);
  assert.equal(store.basisBps('BTCUSDT', T0), null, 'no USDM book yet');
  store.applyBook('USDM', 'BTCUSDT', 99.99, 100.01, T0);
  const expected = ((100.01 - 100.00) / 100.00) * 10_000;
  assert.ok(Math.abs((store.basisBps('BTCUSDT', T0) ?? NaN) - expected) < 1e-9);
  assert.equal(store.basisBps('BTCUSDT', T0 + 60_000), null, 'both stale: no basis');
});

test('snapshot lists every symbol seen on the venue, sorted, and only that venue', () => {
  const store = new PublicQuoteStore(15_000);
  store.applyBook('SPOT', 'ETHUSDT', 1, 2, T0);
  store.applyBook('SPOT', 'BTCUSDT', 100, 101, T0);
  store.applyBook('USDM', 'SOLUSDT', 5, 6, T0);
  assert.deepEqual(Object.keys(store.snapshot('SPOT', T0)), ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(Object.keys(store.snapshot('USDM', T0)), ['SOLUSDT']);
});

test('the store refuses a non-positive staleness window at construction', () => {
  assert.throws(() => new PublicQuoteStore(0));
});

// ---- frame routing ----

test('a bookTicker frame updates the book; a trade frame updates the last price', () => {
  const store = new PublicQuoteStore(15_000);
  assert.equal(applyStreamFrame(store, 'SPOT', 'btcusdt@bookTicker', { u: 1, s: 'BTCUSDT', b: '100', B: '1', a: '101', A: '2' }, T0), true);
  assert.equal(applyStreamFrame(store, 'SPOT', 'btcusdt@trade', { e: 'trade', s: 'BTCUSDT', p: '100.5', T: T0 - 3 }, T0), true);
  const q = store.quote('SPOT', 'BTCUSDT', T0);
  assert.equal(q.bid, 100);
  assert.equal(q.last, 100.5);
  assert.equal(q.tradeAt, T0 - 3, 'trade time is the exchange time when present');
});

test('a frame on an unknown stream, or a payload that fails validation, changes nothing', () => {
  const store = new PublicQuoteStore(15_000);
  assert.equal(applyStreamFrame(store, 'SPOT', 'btcusdt@kline_1m', { s: 'BTCUSDT' }, T0), false);
  assert.equal(applyStreamFrame(store, 'SPOT', 'btcusdt@bookTicker', { s: 'BTCUSDT', b: 'x' }, T0), false);
  assert.equal(applyStreamFrame(store, 'SPOT', 'btcusdt@trade', { e: 'trade', s: 'BTCUSDT', p: '0', T: T0 }, T0), false);
  assert.deepEqual(store.snapshot('SPOT', T0), {});
});

test('stream names are one book and one trade stream per symbol, lowercased', () => {
  assert.deepEqual(streamNames(['BTCUSDT', 'ETHUSDT'], ['bookTicker', 'trade']), [
    'btcusdt@bookTicker', 'btcusdt@trade', 'ethusdt@bookTicker', 'ethusdt@trade',
  ]);
});

// ---- REST clients (fixtures; the USDⓈ-M host is geo-restricted from the build sandbox, so its shape is a fixture) ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the spot client keeps only TRADING symbols from exchangeInfo, and drops the rest', async () => {
  const rest = new PublicRestClient({
    fetchImpl: (async () => json({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING' },
      { symbol: 'ETHUSDT', status: 'BREAK' },
      { symbol: 'XRPUSDT', status: 'TRADING' },
    ] })) as typeof fetch,
  });
  const trading = await new SpotPublicClient(rest).tradingSymbols(['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual([...trading], ['BTCUSDT']);
});

test('the spot bookTicker bootstrap returns null for an unusable side rather than zero', async () => {
  const rest = new PublicRestClient({
    fetchImpl: (async () => json({ symbol: 'BTCUSDT', bidPrice: '61012.68', askPrice: '0' })) as typeof fetch,
  });
  const book = await new SpotPublicClient(rest).bookTicker('BTCUSDT');
  assert.equal(book.bid, 61012.68);
  assert.equal(book.ask, null);
});

test('a malformed exchangeInfo body fails loudly instead of inventing a symbol list', async () => {
  const rest = new PublicRestClient({ fetchImpl: (async () => json({ nope: true })) as typeof fetch });
  await assert.rejects(() => new SpotPublicClient(rest).tradingSymbols(['BTCUSDT']));
});

test('USDⓈ-M funding history: rows sorted oldest first, a negative rate kept, an unparseable row dropped', async () => {
  const rest = new PublicRestClient({
    fetchImpl: (async () => json([
      { symbol: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 3_000 },
      { symbol: 'BTCUSDT', fundingRate: '-0.00020000', fundingTime: 1_000 },
      { symbol: 'BTCUSDT', fundingRate: 'bad', fundingTime: 2_000 },
    ])) as typeof fetch,
  });
  const funding = await new UsdmPublicClient(rest).fundingHistory('BTCUSDT', 8, T0);
  assert.deepEqual([...funding.rates], [-0.0002, 0.0001]);
  assert.equal(funding.lastFundingTime, 3_000);
  assert.equal(funding.lastRate, 0.0001);
  assert.equal(funding.fetchedAt, T0);
});

test('an empty funding history reads as no last rate, not zero', async () => {
  const rest = new PublicRestClient({ fetchImpl: (async () => json([])) as typeof fetch });
  const funding = await new UsdmPublicClient(rest).fundingHistory('BTCUSDT', 8, T0);
  assert.deepEqual([...funding.rates], []);
  assert.equal(funding.lastRate, null);
  assert.equal(funding.lastFundingTime, null);
});
