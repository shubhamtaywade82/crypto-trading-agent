# USD-M route measurements

Measured with `scripts/probe-usdm-routes.ts`: public market data, no keys, no orders.

- Date: 2026-11-17, from the crypto-trading-agent development environment.
- Symbol: ETHUSDT. Each route was open for 15 s, all five at once. This is a single sample.

| Route | Channel | Messages | Event type seen |
|---|---|---|---|
| `wss://fstream.binance.com/ws/ethusdt@trade` (legacy root, control) | trade | 300 | `trade` |
| `wss://fstream.binance.com/ws/ethusdt@aggTrade` (legacy root) | aggTrade | 0 | none |
| `wss://fstream.binance.com/market/stream?streams=ethusdt@aggTrade` | aggTrade | 79 | `aggTrade` |
| `wss://fstream.binance.com/market/ws/ethusdt@aggTrade` | aggTrade | 79 | `aggTrade` |
| `wss://fstream.binance.com/market/stream?streams=ethusdt@markPrice@1s` | markPrice | 15 | `markPriceUpdate` |

## What the measurement means

- The legacy root streams `@trade`. The fleet's npm `subscribeTrades` feed and the cockpit's `usdmTradeWsUrl` both dial it, so the current tick feed is live.
- `@aggTrade` streams on `/market`, and the legacy root is silent for it. Moving the feed to `/market` would mean subscribing to `@aggTrade`, not `@trade`.
- `@markPrice@1s` streams on `/market`.
- This does not overturn the 2026-11-03 note in `src/binance/wsRoutes.ts`, which records `@trade` silent on `/market`. This run did not test `@trade` on `/market`.

## Reproduce

```sh
npx tsx scripts/probe-usdm-routes.ts ETHUSDT 15
```

Measure again before any route change. Binance can move a channel without notice. If the tick feed goes silent, the fleet's entry gate refuses entries rather than trading on stale prices.
