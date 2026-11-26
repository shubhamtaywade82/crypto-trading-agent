/**
 * The only HTTP and WebSocket surfaces the public market-data layer may touch.
 *
 * Every REST entry is a documented `NONE` (no API key, no signature) GET, classified in REQUIREMENTS.md. Anything not
 * listed here is refused before a request leaves the process. The `MARKET_DATA` class (API key, no signature) is never
 * listed: it needs a key, and this layer holds none.
 */

export const SPOT_DATA_ORIGIN = 'https://data-api.binance.vision';
export const USDM_REST_ORIGIN = 'https://fapi.binance.com';
export const SPOT_STREAM_ORIGIN = 'wss://data-stream.binance.vision';
export const USDM_PUBLIC_STREAM_ORIGIN = 'wss://fstream.binance.com';

export interface PublicRestEndpoint {
  readonly id: string;
  readonly origin: string;
  readonly path: string;
}

export const PUBLIC_REST_ENDPOINTS: readonly PublicRestEndpoint[] = [
  { id: 'spot.exchangeInfo', origin: SPOT_DATA_ORIGIN, path: '/api/v3/exchangeInfo' },
  { id: 'spot.bookTicker', origin: SPOT_DATA_ORIGIN, path: '/api/v3/ticker/bookTicker' },
  { id: 'usdm.fundingRate', origin: USDM_REST_ORIGIN, path: '/fapi/v1/fundingRate' },
];

// Query keys that carry a credential or a signature. A public request never carries one, so any of these is a bug.
const FORBIDDEN_QUERY_KEY = /^(signature|timestamp|recvwindow|apikey|api_key|listenkey|secret)$/i;
// Header names that carry a credential, compared case-insensitively
const FORBIDDEN_HEADER = /^(x-mbx-apikey|x-mbx-sign|authorization)$/i;

/** Thrown when code tries to reach a surface outside the public registry. The request is never sent. */
export class PublicOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicOnlyViolation';
  }
}

/** Resolves a REST request to its registry entry, or throws. Pure: no network. */
export function resolvePublicRest(method: string, url: URL, headers: Readonly<Record<string, string>> = {}): PublicRestEndpoint {
  if (method.toUpperCase() !== 'GET') throw new PublicOnlyViolation(`${method} ${url.pathname} is not a public GET`);
  if (url.protocol !== 'https:') throw new PublicOnlyViolation(`${url.protocol} is not https`);
  const endpoint = PUBLIC_REST_ENDPOINTS.find((e) => url.origin === e.origin && url.pathname === e.path);
  if (!endpoint) throw new PublicOnlyViolation(`${url.origin}${url.pathname} is not in the public endpoint registry`);
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_QUERY_KEY.test(key)) throw new PublicOnlyViolation(`query parameter "${key}" is a credential or signature field`);
  }
  for (const name of Object.keys(headers)) {
    if (FORBIDDEN_HEADER.test(name)) throw new PublicOnlyViolation(`header "${name}" carries a credential`);
  }
  return endpoint;
}

/**
 * Resolves a WebSocket URL to a public market-data route, or throws. Spot uses the data-only host; USDⓈ-M public
 * data is only ever on `/public` (depth and bookTicker). `/market`, `/private`, listenKey and the legacy roots are
 * refused here: the existing @trade feed dials the legacy root on its own path and does not go through this guard.
 */
export function resolvePublicWs(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'wss:') throw new PublicOnlyViolation(`${url.protocol} is not wss`);
  if (/listenkey|\/private(\/|$)/i.test(url.pathname + url.search)) throw new PublicOnlyViolation('user-data or private stream route');
  const origin = `wss://${url.host}`;
  if (origin === SPOT_STREAM_ORIGIN) {
    if (!/^\/(ws|stream)(\/|$)/.test(url.pathname)) throw new PublicOnlyViolation(`${url.pathname} is not a spot market-data route`);
    return url;
  }
  if (origin === USDM_PUBLIC_STREAM_ORIGIN) {
    if (!/^\/public\/(ws|stream)(\/|$)/.test(url.pathname)) throw new PublicOnlyViolation(`${url.pathname} is not the USDⓈ-M /public route`);
    return url;
  }
  throw new PublicOnlyViolation(`${origin} is not a public market-data origin`);
}
