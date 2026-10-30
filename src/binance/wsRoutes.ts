/**
 * USDⓈ-M futures WebSocket routing after Binance's base-URL split (migration notice:
 * "Important WebSocket Change Notice — Base URL Split & Migration", legacy URLs retired 2026-04-23).
 *
 * Verified contract (official notice, quoted):
 *   Public  (high-frequency data: bookTicker, depth):
 *     wss://fstream.binance.com/public/ws/bnbusdt@depth/ethusdt@depth        (ws mode, path-based)
 *     wss://fstream.binance.com/public/stream?streams=btcusdt@depth/ethusdt@depth   (stream mode)
 *   Market  (regular market data: aggTrade, markPrice, kline, ticker, trade, ...):
 *     wss://fstream.binance.com/market/ws/btcusdt@aggTrade/ethusdt@aggTrade
 *     wss://fstream.binance.com/market/stream?streams=bnbusdt@aggTrade/btcusdt@markPrice
 *   Private (user data):
 *     wss://fstream.binance.com/private/ws?listenKey=<listenKey1>&events=ORDER_TRADE_UPDATE/ACCOUNT_UPDATE
 *     wss://fstream.binance.com/private/stream?listenKey=<k1>&events=ORDER_TRADE_UPDATE&listenKey=<k2>&events=ACCOUNT_UPDATE
 *
 * Un-migrated connections only receive the public channels: "wss://fstream.binance.com/ws/btcusdt@markPrice
 * will not [work]" — which is why the legacy paths must not appear anywhere below.
 *
 * Testnet: Binance's notice does not document routed paths for the testnet host. The testnet bases
 * therefore keep Binance's documented testnet host with the same route suffixes and are explicitly
 * marked UNVERIFIED; override them with WS_*_BASE if/when Binance documents testnet routing.
 */

export type UsdmWsEnvironment = 'live' | 'testnet';

const LIVE_WS_ROOT = 'wss://fstream.binance.com';
const TESTNET_WS_ROOT = 'wss://fstream.binancefuture.com';

/** Route roots per environment. `unverifiedRouting` flags the testnet suffixes as not Binance-documented. */
export interface WsRouteBases {
  readonly market: string;
  readonly private: string;
  readonly public: string;
  readonly unverifiedRouting: boolean;
}

export function usdmWsRouteBases(environment: UsdmWsEnvironment, overrides?: { market?: string; private?: string; public?: string }): WsRouteBases {
  const root = environment === 'testnet' ? TESTNET_WS_ROOT : LIVE_WS_ROOT;
  const bases: WsRouteBases = {
    market: `${root}/market`,
    private: `${root}/private`,
    public: `${root}/public`,
    unverifiedRouting: environment === 'testnet',
  };
  return {
    ...bases,
    ...(overrides?.market === undefined ? {} : { market: overrides.market }),
    ...(overrides?.private === undefined ? {} : { private: overrides.private }),
    ...(overrides?.public === undefined ? {} : { public: overrides.public }),
  };
}

/** Base the `binance` package's WebsocketClient must be given so its `/ws/<stream>` suffix lands on the market route. */
export function usdmMarketWsUrl(environment: UsdmWsEnvironment): string {
  return usdmWsRouteBases(environment).market;
}

/**
 * Query-value encoding that keeps the characters Binance documents literally in its URLs (`/` between
 * event names, `@` in stream names) while encoding everything that could alter the query structure
 * (`&`, `=`, `?`, `#`, …).
 */
const encodeQueryValue = (value: string): string => encodeURIComponent(value).replace(/%40/g, '@').replace(/%2F/g, '/');

/** Path-segment encoding that keeps `@` (part of every documented stream name) but encodes `/`, `?`, `#`. */
const encodePathSegment = (value: string): string => encodeURIComponent(value).replace(/%40/g, '@');

/**
 * A market-data stream URL in ws mode (path-based), the form the existing subscription code emits
 * one stream per symbol at: `<market base>/ws/<symbol>@<stream>`.
 */
export function buildMarketStreamUrl(environment: UsdmWsEnvironment, streams: readonly string[]): string {
  if (streams.length === 0) throw new Error('a market stream URL needs at least one stream name');
  const encoded = streams.map((s) => encodePathSegment(s));
  return `${usdmWsRouteBases(environment).market}/ws/${encoded.join('/')}`;
}

/** User-data events this bot consumes from the private stream. All are documented USDⓈ-M user-data events. */
export const USER_DATA_EVENTS = ['ORDER_TRADE_UPDATE', 'ACCOUNT_UPDATE', 'MARGIN_CALL'] as const;

/**
 * The private user-data URL in ws mode. The listen key is a query parameter — the legacy path form
 * `/private/ws/<listenKey>` (or `/ws/<listenKey>`) is wrong and must not come back.
 */
export function buildPrivateStreamUrl(environment: UsdmWsEnvironment, listenKey: string, events: readonly string[] = USER_DATA_EVENTS): string {
  if (typeof listenKey !== 'string' || listenKey.length === 0) throw new Error('a private stream URL needs a listen key');
  if (events.length === 0) throw new Error('a private stream URL needs at least one event name');
  const query = `listenKey=${encodeQueryValue(listenKey)}&events=${encodeQueryValue(events.join('/'))}`;
  return `${usdmWsRouteBases(environment).private}/ws?${query}`;
}

/** Listen keys are credentials: logs may carry at most this masked form. */
export function maskListenKey(listenKey: string): string {
  if (typeof listenKey !== 'string' || listenKey.length === 0) return '<none>';
  if (listenKey.length <= 8) return `${listenKey.slice(0, 2)}…`;
  return `${listenKey.slice(0, 4)}…${listenKey.slice(-3)}`;
}
