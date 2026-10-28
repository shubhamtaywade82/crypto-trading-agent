# Live market brief

`npm run brief -- --symbol SOLUSDT` produces a one-shot, read-only decision brief for a single
Binance USDⓈ-M perpetual, in the shape an operator reads before a session: an executive call
(trade / no-trade / wait for confirmation), the evidence behind it in numbered sections, and the
exact conditions that would change the call. This note records where each figure comes from and
the rules the executive gate follows, so the brief's conclusions can be reproduced from its inputs.

## Pipeline

```
scripts/market-brief.ts        CLI: --symbol, --compare, --data-dir, --out, --json
  └─ src/brief/MarketBriefData.ts    collectBriefMarketData(): public endpoints -> BriefMarketData
       └─ src/brief/MarketBriefBuilder.ts   buildMarketBrief(): pure analysis -> MarketBrief
            └─ src/brief/render.ts    renderBriefMarkdown(): MarketBrief -> markdown
```

The collection layer talks to a `Pick<USDMClient, ...>` of read-only public endpoints (injectable,
so `tests/marketBrief.test.ts` runs without a network). The builder is pure: no I/O, no clock
reads beyond the passed timestamp, deterministic rules only. The renderer is presentation only.

## Data sources

| Brief section | Endpoint(s) | Notes |
| --- | --- | --- |
| 1. Price and 24h statistics | `get24hrChangeStatistics`, `getMarkPrice`, `getOrderBook` | Mark/index carry an extra decimal (mark tick vs trade tick). Best bid/ask and the largest displayed level per side come from one depth snapshot. |
| 2. Multi-timeframe structure | `getKlines` for 5m/15m/1h/4h | `splitKlines` separates closed candles from the single forming candle: a candle is confirmed only when `openTime + intervalMs <= now`. Labels use the candle's open time ("03:00 close" = the candle that opened 03:00). |
| 3. Derivatives, positioning, order flow | `getMarkPrice` (funding, next funding), `getOpenInterest`, `getOpenInterestStatistics` (hourly, 5 snapshots), `getGlobalLongShortAccountRatio`, `getTopTradersLongShortPositionRatio`, `getTakerBuySellVolume` for 5m/15m/1h | Account shares arrive as decimals (0.7488 = 74.88%) and are derived from the ratio when absent. Taker buckets are stamped with their START time and rendered as the covered window, because buckets for different periods do not end together. |
| 4. Support and resistance | confirmed 15m/1h/4h candles + 24h range | Fractal swings (k = 2 confirmed candles each side), clustered when levels sit within 0.15% of price. Lookback is bounded (15m: 24h, 1h: 3d, 4h: 7d) and levels further than 8% from price are dropped. The 24h high clusters into resistance; the 24h low is reported as its own major reference. |
| 7. Change vs recorded context | `data/market/SYMBOL-*.jsonl` (see `scripts/record-market-data.ts`) | Compares the current reading against the LAST recorded snapshot of each requested day. Point-in-time comparisons, never period returns; missing baselines are stated, never estimated. |

## The executive gate

- **Structure trend** per timeframe: confirmed closes only — the last close must agree with both
  the prior close and the close three bars back (UP/DOWN), otherwise FLAT.
- **No-entry band**: from the low of the nearest support zone (immediate support) to the high of
  the nearest resistance zone (the reclaim zone).
- **LONG_BIAS** requires a *confirmed 15m close above the reclaim zone's high*.
- **SHORT_BIAS** requires a *confirmed 15m close below the immediate support's low*.
- Everything else — including a break that only the still-forming candle shows, and a live price
  beyond a level the confirming candle has not closed beyond — is **NO_TRADE**, with reasons:
  price inside the no-entry band; forming-candle dips that are not confirmation; 1h/4h vs 5m/15m
  conflict; sell-dominant short-interval taker flow; OI declining under a bullish recovery;
  long-crowded account ratios (>= 2:1); incomplete zone map; failed endpoints.

No probability is assigned to any scenario: the available evidence does not establish a calibrated
probability of success, and a stated probability would be unfalsifiable decoration.

## Honesty contract

- Missing readings render as "—" and the failing endpoint is named in a data-availability note.
  Values are never substituted from another endpoint or invented (an unavailable top-trader ratio
  says "not available in the retrieved data", not a COIN-M or stale figure).
- Forming candles are always labeled as forming; they never enter trend, zone or confirmation
  calculations.
- Zone and scenario wording repeats that zones are observed areas, not guaranteed turning points,
  and book concentrations are transient.
- The OI notional and funding APR are approximations and say so (price x OI; 8h settlement
  assumed).

## Relationship to the trading loop

The brief is intentionally standalone: it reads public endpoints directly, imports no app config,
and never approaches the executor. It shares the philosophy of `buildSetupMap` (scenarios with
trigger/invalidation, NO_TRADE as a first-class outcome) but is a snapshot for a human, not a
signal source. Wiring it into the loop (a fourth ink view, or journaling each brief alongside
`DecisionRecord`s) is future work; the type model (`src/brief/types.ts`) is the contract that
would survive it.
