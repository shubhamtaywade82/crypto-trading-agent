import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PUBLIC_REST_ENDPOINTS,
  PublicOnlyViolation,
  resolvePublicRest,
  resolvePublicWs,
} from '../src/market/public/endpointRegistry.js';
import { PublicRestClient, PublicRestError } from '../src/market/public/PublicRestClient.js';

const spotBook = new URL('https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT');

test('a registered public GET resolves to its registry entry', () => {
  const endpoint = resolvePublicRest('GET', spotBook, { Accept: 'application/json' });
  assert.equal(endpoint.id, 'spot.bookTicker');
});

test('every registry entry is https and names an exact path, with no wildcard or query in the path', () => {
  for (const endpoint of PUBLIC_REST_ENDPOINTS) {
    assert.ok(endpoint.origin.startsWith('https://'), endpoint.id);
    assert.ok(!endpoint.path.includes('*') && !endpoint.path.includes('?'), endpoint.id);
  }
});

test('a non-GET method is refused before any request, even on a registered path', () => {
  assert.throws(() => resolvePublicRest('POST', spotBook), PublicOnlyViolation);
  assert.throws(() => resolvePublicRest('DELETE', spotBook), PublicOnlyViolation);
});

test('an unregistered path on a known origin is refused, including account and order paths', () => {
  for (const path of ['/api/v3/order', '/api/v3/account', '/api/v3/userDataStream', '/fapi/v2/account', '/fapi/v1/order', '/sapi/v1/capital/config/getall']) {
    const origin = path.startsWith('/fapi') ? 'https://fapi.binance.com' : 'https://data-api.binance.vision';
    assert.throws(() => resolvePublicRest('GET', new URL(path, origin)), PublicOnlyViolation, path);
  }
});

test('a registered path on the wrong origin is refused', () => {
  assert.throws(() => resolvePublicRest('GET', new URL('https://api.binance.com/api/v3/ticker/bookTicker')), PublicOnlyViolation);
});

test('plain http is refused', () => {
  assert.throws(() => resolvePublicRest('GET', new URL('http://data-api.binance.vision/api/v3/ticker/bookTicker')), PublicOnlyViolation);
});

test('a signature, timestamp, recvWindow or API key in the query is refused', () => {
  for (const key of ['signature', 'timestamp', 'recvWindow', 'apiKey', 'api_key', 'listenKey']) {
    const url = new URL('https://data-api.binance.vision/api/v3/ticker/bookTicker');
    url.searchParams.set(key, 'x');
    assert.throws(() => resolvePublicRest('GET', url), PublicOnlyViolation, key);
  }
});

test('a credential header is refused, whatever its case', () => {
  assert.throws(() => resolvePublicRest('GET', spotBook, { 'X-MBX-APIKEY': 'k' }), PublicOnlyViolation);
  assert.throws(() => resolvePublicRest('GET', spotBook, { 'x-mbx-apikey': 'k' }), PublicOnlyViolation);
  assert.throws(() => resolvePublicRest('GET', spotBook, { Authorization: 'Bearer t' }), PublicOnlyViolation);
});

test('public WebSocket routes: spot data-stream and USDⓈ-M /public are accepted', () => {
  assert.equal(resolvePublicWs('wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/btcusdt@trade').host, 'data-stream.binance.vision');
  assert.equal(resolvePublicWs('wss://fstream.binance.com/public/stream?streams=btcusdt@bookTicker').pathname, '/public/stream');
});

test('WebSocket routes outside the public set are refused: private, listenKey, /market user routes, legacy root, unknown hosts', () => {
  const refused = [
    'wss://fstream.binance.com/private/ws?listenKey=abc',
    'wss://fstream.binance.com/ws/btcusdt@trade',
    'wss://fstream.binance.com/market/ws/btcusdt@trade',
    'wss://fstream.binance.com/stream?streams=btcusdt@depth',
    'wss://data-stream.binance.vision/private/ws/abc',
    'wss://ws-api.binance.com:443/ws-api/v3',
    'wss://stream.binance.com:9443/ws/btcusdt@bookTicker',
    'ws://data-stream.binance.vision/ws/btcusdt@trade',
  ];
  for (const raw of refused) assert.throws(() => resolvePublicWs(raw), PublicOnlyViolation, raw);
});

// ---- keyless REST client ----

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('the REST client sends no credential header and only the query it was given', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const client = new PublicRestClient({
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      return jsonResponse({ symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' });
    }) as typeof fetch,
  });
  const body = await client.getJson('spot.bookTicker', { symbol: 'BTCUSDT' });
  assert.deepEqual(body, { symbol: 'BTCUSDT', bidPrice: '1', askPrice: '2' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, 'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT');
  assert.deepEqual(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase()), ['accept']);
});

test('an unknown endpoint id is refused without a request', async () => {
  let calls = 0;
  const client = new PublicRestClient({ fetchImpl: (async () => { calls += 1; return jsonResponse({}); }) as typeof fetch });
  await assert.rejects(() => client.getJson('spot.order'), PublicOnlyViolation);
  assert.equal(calls, 0);
});

test('HTTP 429 sets a backoff from Retry-After; nothing is sent until it passes', async () => {
  let now = 1_000_000;
  let calls = 0;
  const client = new PublicRestClient({
    now: () => now,
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ code: -1003 }, 429, { 'Retry-After': '30' }) : jsonResponse({ symbol: 'BTCUSDT' });
    }) as typeof fetch,
  });
  await assert.rejects(() => client.getJson('spot.bookTicker', { symbol: 'BTCUSDT' }), (err: unknown) =>
    err instanceof PublicRestError && err.status === 429);
  assert.equal(client.backoffRemainingMs(), 30_000);
  await assert.rejects(() => client.getJson('spot.bookTicker', { symbol: 'BTCUSDT' }), (err: unknown) =>
    err instanceof PublicRestError && err.status === null, 'must fail fast during backoff');
  assert.equal(calls, 1, 'no request leaves the process while the backoff holds');
  now += 30_001;
  assert.equal(await client.getJson('spot.bookTicker', { symbol: 'BTCUSDT' }).then((b) => (b as { symbol: string }).symbol), 'BTCUSDT');
  assert.equal(calls, 2);
});

test('HTTP 418 without Retry-After uses the default backoff', async () => {
  let now = 0;
  const client = new PublicRestClient({
    now: () => now,
    defaultBackoffMs: 90_000,
    fetchImpl: (async () => jsonResponse({}, 418)) as typeof fetch,
  });
  await assert.rejects(() => client.getJson('spot.exchangeInfo'));
  assert.equal(client.backoffRemainingMs(), 90_000);
});

test('a timeout or a network error is a PublicRestError with no status, not a crash', async () => {
  const client = new PublicRestClient({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(() => client.getJson('spot.exchangeInfo'), (err: unknown) =>
    err instanceof PublicRestError && err.status === null && /fetch failed/.test(err.message));
});

test('a non-JSON body is a PublicRestError', async () => {
  const client = new PublicRestClient({ fetchImpl: (async () => new Response('<html>', { status: 200 })) as typeof fetch });
  await assert.rejects(() => client.getJson('spot.exchangeInfo'), (err: unknown) =>
    err instanceof PublicRestError && /not JSON/.test(err.message));
});

test('a 451 (restricted location) is surfaced as an HTTP error, not retried', async () => {
  let calls = 0;
  const client = new PublicRestClient({ fetchImpl: (async () => { calls += 1; return jsonResponse({ code: 0 }, 451); }) as typeof fetch });
  await assert.rejects(() => client.getJson('usdm.fundingRate', { symbol: 'BTCUSDT' }), (err: unknown) =>
    err instanceof PublicRestError && err.status === 451);
  assert.equal(calls, 1);
  assert.equal(client.backoffRemainingMs(), 0, 'a 451 is not a rate limit and sets no backoff');
});

// ---- source scan: the public-data modules hold no credential and no signed or listen-key code ----

const FORBIDDEN_IN_PUBLIC_CODE = [
  /new\s+USDMClient\s*\(/,
  /createListenKey|keepAliveListenKey|closeListenKey/,
  /listenKey\s*\(/,
  /BINANCE_API_KEY|BINANCE_API_SECRET|config\.binance\.apiKey|config\.binance\.apiSecret/,
  /apiSecret\s*:/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('no public-data module references a credential, a signed client or a listen-key call', () => {
  const roots = [join(process.cwd(), 'src/market/public'), join(process.cwd(), 'src/market/spot')];
  const files = roots.flatMap(sourceFiles);
  assert.ok(files.length > 0, 'the public-data directories must exist');
  const offenders = files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return FORBIDDEN_IN_PUBLIC_CODE.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
  });
  assert.deepEqual(offenders, []);
});
