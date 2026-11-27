# Market Data V2

This increment adds the native market-data and derivatives foundation needed by the next strategy iterations.

## Native candles

The service caches closed candles independently for:

- 1m
- 5m
- 15m
- 1h
- 4h

The existing 15m path remains the fallback when Market Data V2 is disabled or a native 15m refresh is unavailable.

## Derivatives and microstructure

The snapshot can expose:

- current open interest
- recent open-interest change
- global long/short ratio
- top-trader account long/short ratio
- top-trader position long/short ratio
- taker buy/sell ratio
- taker volume imbalance
- top-N order-book notional imbalance
- top-of-book spread in basis points
- optional basis data

These fields are observable market proxies. They are not direct measurements of institutional intent.

## Refresh and load control

Default TTLs:

- 1m: 15 seconds (`MARKET_DATA_1M_TTL_MS`)
- 5m: 60 seconds (`MARKET_DATA_5M_TTL_MS`)
- 15m: 60 seconds (`MARKET_DATA_15M_TTL_MS`)
- 1h: 5 minutes (`MARKET_DATA_1H_TTL_MS`)
- 4h: 15 minutes (`MARKET_DATA_4H_TTL_MS`)
- derivatives: 5 minutes (`MARKET_DATA_DERIVATIVES_TTL_MS`)

Refresh work is concurrency-limited to avoid a large burst of public requests.

Failed kline refreshes receive a bounded retry backoff. Derivatives use all-settled reads so one unavailable endpoint does not discard the other observations.

## Safety contract

Market Data V2 is on: `src/config.ts` sets `marketDataV2.enabled` to `true` and has no environment switch for it. It can be disabled only in code.

It only supplies read-only context. Existing strategy generation, RiskAgent approval, stop management, and order execution remain unchanged.

MarketStateBuilder prefers native 15m/1h/4h data when present and falls back to the existing 15m resampling path.

## Basis

The Binance Node SDK exposes getBasis, but its current source comments mark that method as possibly deprecated. Basis is on: `src/config.ts` sets `marketDataV2.basisEnabled` to `true`, with no environment switch. Its endpoint has not been re-validated since that default changed, so treat basis values as unverified until it is.

## Validation

Tests use an injected fake market-data client. They verify:

- forming-candle exclusion
- five native timeframe requests
- derivatives normalization
- order-book calculations
- concurrency caps
- TTL caching
- partial endpoint failure handling
- optional basis behavior
- native MarketStateBuilder preference
- configuration validation
