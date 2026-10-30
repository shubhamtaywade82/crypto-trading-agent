import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMarketStreamUrl, buildPrivateStreamUrl, maskListenKey, usdmMarketWsUrl, usdmWsRouteBases, USER_DATA_EVENTS,
} from '../src/binance/wsRoutes.js';

/**
 * Binance's "Important WebSocket Change Notice — Base URL Split & Migration" (legacy URLs retired
 * 2026-04-23) is the contract these tests pin. Every URL below is asserted against the shapes the
 * notice documents verbatim, so a regression back to the legacy /ws/<listenKey> or the un-routed
 * root cannot pass silently.
 */

test('live USD-M route bases separate market, private and public traffic', () => {
  const bases = usdmWsRouteBases('live');
  assert.equal(bases.market, 'wss://fstream.binance.com/market');
  assert.equal(bases.private, 'wss://fstream.binance.com/private');
  assert.equal(bases.public, 'wss://fstream.binance.com/public');
  assert.equal(bases.unverifiedRouting, false);
});

test('testnet keeps Binance\'s documented testnet host and flags its routed paths as unverified', () => {
  const bases = usdmWsRouteBases('testnet');
  assert.equal(bases.market, 'wss://fstream.binancefuture.com/market');
  assert.equal(bases.private, 'wss://fstream.binancefuture.com/private');
  // Binance's migration notice documents no testnet routing: the suffixes are our best effort and marked as such
  assert.equal(bases.unverifiedRouting, true);
});

test('explicit base overrides win, so an operator can pin a documented endpoint', () => {
  const bases = usdmWsRouteBases('live', { private: 'wss://example.invalid/private' });
  assert.equal(bases.private, 'wss://example.invalid/private');
  assert.equal(bases.market, 'wss://fstream.binance.com/market');
});

test('the market base for the websocket package produces the documented /market/ws/<stream> URL', () => {
  // the `binance` package appends /ws/<stream> itself, so the base must be the bare market route
  assert.equal(usdmMarketWsUrl('live'), 'wss://fstream.binance.com/market');
  assert.equal(usdmMarketWsUrl('testnet'), 'wss://fstream.binancefuture.com/market');
});

test('market stream URLs are path-based and carry every stream', () => {
  assert.equal(buildMarketStreamUrl('live', ['btcusdt@trade']), 'wss://fstream.binance.com/market/ws/btcusdt@trade');
  assert.equal(
    buildMarketStreamUrl('live', ['btcusdt@aggTrade', 'ethusdt@markPrice']),
    'wss://fstream.binance.com/market/ws/btcusdt@aggTrade/ethusdt@markPrice',
  );
  assert.throws(() => buildMarketStreamUrl('live', []), /at least one stream/);
});

test('market stream names stay in the documented form, but structure characters are encoded', () => {
  assert.equal(
    buildMarketStreamUrl('live', ['btcusdt@trade?listenKey=stolen']),
    'wss://fstream.binance.com/market/ws/btcusdt@trade%3FlistenKey%3Dstolen',
  );
  assert.equal(
    buildMarketStreamUrl('live', ['btcusdt@trade#fragment']),
    'wss://fstream.binance.com/market/ws/btcusdt@trade%23fragment',
  );
});

test('private URLs put the listen key and events in the query, exactly as the migration notice documents', () => {
  assert.equal(
    buildPrivateStreamUrl('live', 'KEY123', ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE']),
    'wss://fstream.binance.com/private/ws?listenKey=KEY123&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE',
  );
});

test('private URLs default to the user-data events this bot consumes', () => {
  const url = buildPrivateStreamUrl('live', 'KEY123');
  assert.ok(url.endsWith('events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/MARGIN_CALL'));
  assert.deepEqual([...USER_DATA_EVENTS], ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE', 'MARGIN_CALL']);
});

test('private URLs refuse an empty or missing listen key instead of dialing a keyless endpoint', () => {
  assert.throws(() => buildPrivateStreamUrl('live', ''), /listen key/);
  assert.throws(() => buildPrivateStreamUrl('live', undefined as unknown as string), /listen key/);
  assert.throws(() => buildPrivateStreamUrl('live', 'KEY', []), /at least one event/);
});

test('a listen key with reserved characters cannot break the query structure, and decodes back exactly', () => {
  const url = buildPrivateStreamUrl('live', 'KEY/with?reserved&chars=extra');
  const value = url.slice(url.indexOf('listenKey=') + 'listenKey='.length, url.indexOf('&events='));
  assert.ok(!/[&=?#]/.test(value), `a structural character stayed raw: ${value}`);
  const parsed = new URL(url).searchParams;
  assert.equal(parsed.get('listenKey'), 'KEY/with?reserved&chars=extra');
  assert.equal(parsed.get('events'), 'ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/MARGIN_CALL');
});

test('regression: no URL this module builds ever uses the legacy /ws/<listenKey> or /public/ws route for user data', () => {
  const url = buildPrivateStreamUrl('live', 'abc123def456', ['ORDER_TRADE_UPDATE']);
  assert.ok(!url.includes('/public/'), 'user data must not ride the public route');
  assert.ok(!/\/ws\/[A-Za-z0-9]/.test(url), 'the listen key must be a query parameter, not a path segment');
  assert.ok(url.startsWith('wss://fstream.binance.com/private/ws?'));
});

test('route bases never cross products: nothing here touches COIN-M, spot or options hosts', () => {
  const all = [usdmWsRouteBases('live'), usdmWsRouteBases('testnet')].flatMap((b) => [b.market, b.private, b.public]);
  for (const url of all) {
    assert.ok(!url.includes('dapi'), 'COIN-M (dapi) must not be touched');
    assert.ok(!url.includes('stream.binance.com:'), 'spot must not be touched');
    assert.ok(!url.includes('eapi'), 'options must not be touched');
  }
});

test('listen keys are masked for logs: never the full key', () => {
  assert.equal(maskListenKey('abcdefghij'), 'abcd…hij');
  assert.equal(maskListenKey('short'), 'sh…');
  assert.equal(maskListenKey(''), '<none>');
  const masked = maskListenKey('a-very-long-listen-key-value');
  assert.ok(!masked.includes('long-listen'));
});
