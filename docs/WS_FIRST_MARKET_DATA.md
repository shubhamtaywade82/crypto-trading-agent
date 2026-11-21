# WebSocket-first market data and REST rate guard

Goal: stop polling Binance REST for data a WebSocket stream already carries, and make sure no REST path can
keep hitting the venue after it has said to stop.

## Route evidence

`scripts/probe-usdm-routes.ts BTCUSDT 15` on 2026-11-17, 15 s per route:

| Route | Messages | Verdict |
|---|---|---|
| legacy `/ws/btcusdt@trade` (control) | 655 | streams |
| legacy `/ws/btcusdt@aggTrade` | 0 | silent |
| `/market/stream` `@aggTrade` | 214 | streams |
| `/market/stream` `@markPrice@1s` | 15 | streams |
| `/market/stream` `@kline_1m` | 29 | streams |
| legacy `/ws/btcusdt@kline_1m` | 0 | silent |

Kline streams are on `/market`. The feed uses `usdmWsRouteBases(env).market`. A raw frame was captured to confirm the
shape: `{"stream":"btcusdt@kline_1m","data":{"e":"kline","s":"BTCUSDT","k":{"t","T","i","o","c","h","l","v","x",...}}}`.
`k.x` is true once the candle is final.

## What changed

- `src/core/adapters/binance/restGuard.ts`: one process-wide gate in front of every live `USDMClient`.
  - A rate-limit answer (code -1003, 418/429, or a `Retry-After` header) pauses all REST calls for the wait it names.
    The ban text's `banned until <epoch ms>` is honoured when present. Default when no wait is named: 60 s.
  - Calls are refused once the minute's `x-mbx-used-weight-1m` reaches 90% of 2400. The reading counts only if a
    response arrived in the current minute, so a stale reading cannot lock the client out.
  - Refused calls reject with `RestBackoffError` and never reach the venue. Shared state, not per client: Binance limits
    by IP.
  - The package's thrown error has no HTTP status, so classification uses the code and the header.
- `src/market/KlineStreamCache.ts`: closed-candle series kept current from frames. A series is served only when it is
  seeded, no invalidation is pending, a frame arrived within 15 s, and its newest closed candle is at most one interval
  behind. Otherwise it returns `null` and the caller reads REST.
- `src/market/KlineStreamFeed.ts`: one combined `/market/stream` socket for all symbols and intervals. Backfills run one
  at a time. A drop invalidates the cache at once, then reconnects with exponential backoff. A failed backfill retries
  on a 15 s timer, not on each frame.
- `MarketDataService` takes an optional `KlineSource`. A stream-served series costs no REST call.
- `RetryingMarketData` no longer retries rate-limit or backoff refusals. Retrying them only extends a ban.

Wired into: `BinanceService` (orchestrator, started with the real-time stream), `FleetSupervisor`, `scripts/run-fleet.ts`,
and `scripts/market-brief.ts` (guard only).

## REST still in use, and why

| Data | Calls | Why still REST |
|---|---|---|
| Open interest, OI history, global and top-trader long/short ratios, taker buy/sell, basis | 7 per symbol per `MARKET_DATA_DERIVATIVES_TTL_MS` (60 s) | Binance publishes no WebSocket stream for these. Candidate for a longer TTL (decision). |
| Order-book depth | 1 per symbol per 60 s | A partial-depth stream exists on `/public`. Not converted in this pass. |
| Live positions, open orders, journal, brackets | per live cycle, 60 s guards | User-data `ACCOUNT_UPDATE` could replace position polling. Not converted. |
| Options desk (15 s loop), market brief (5 min), SMC-ML premium index and klines, trailing-shadow klines | per their loops | Not audited in depth this pass. Next candidates. |

Fleet effect (4 symbols, default TTLs): about 57 REST calls per minute before, 32 after. The remaining 32 are derivatives and order-book depth (8 per symbol).

## Limits of this verification

- Live kline frames were received (58 in 25 s, connected). The backfill returned HTTP 451 from `fapi.binance.com` in
  this container, so seeding was not exercised live. The seeded-and-served path is covered by unit tests only.
- The guard's 2400 weight limit is the documented USDⓈ-M default, not read from the account's `rateLimits`. A live
  429 was not reproduced.
- Testnet routing for the kline feed is unverified, as for the trade feed.

## Decisions resolved

1. **Derivatives TTL**: Increased default to 300 s (`MARKET_DATA_DERIVATIVES_TTL_MS=300000`, env-overridable). The derivatives data arrives in 5-minute granularity on Binance, cutting derivatives REST calls by 80%.
2. **Protective writes during backoff**: Cancel orders and reduce-only closes bypass the local 90% weight ceiling (audited via `[restGuard] protective write bypassed local weight ceiling`). Venue-imposed bans (`Retry-After` header or 418 code) are strictly enforced and cannot be bypassed.
3. **Duplicate sockets**: Added `UsdmStreamRegistry` (`src/market/UsdmStreamRegistry.ts`) providing refcounted stream subscriptions so kline and depth sockets are shared across the orchestrator, fleet supervisor, and feeds without duplicate connections.
4. **Order-book depth via WebSocket**: Added `DepthSource` port (`src/market/OrderBookDepthSource.ts`) for `MarketDataService`. When local order books are live and fresh, REST `getOrderBook` calls are eliminated entirely. Fallback to REST occurs seamlessly if books are syncing or stale.
