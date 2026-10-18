# ALMA / multi-timeframe research workspace

**Status:** Workspace setup only. Parameter search has not been run.  
**Instrument:** SOLUSDT USDⓈ-M perpetual futures.  
**Exchange boundary:** @nemesis-oss/binance-sdk v3, public market-data methods only.  
**Safety boundary:** This workspace does not submit orders and does not import the live execution path.

## Why this workspace exists

We are investigating the behavior of ALMA(9) and ALMA(21), but the research must not assume those lengths are special. The system will measure events such as:

- ALMA fast/slow crosses, cross direction and subsequent separation/expansion.
- Price extension away from ALMA(9) or ALMA(21), pullback, touch/reclaim, rejection and continuation.
- Failed reclaim, recross, line convergence/compression and post-extension exhaustion.
- Same-timeframe events versus confirmed multi-timeframe (MTF) confluence.
- Sensitivity to both ALMA lengths, source, offset, sigma, slope, event thresholds, confirmation, stops, targets and holding horizon.

## Layout

~~~text
research/alma/
├── README.md
├── config/
│   ├── experiment.v1.json
│   └── search-space.v1.json
├── docs/
│   ├── DATA_CONTRACT.md
│   └── RESEARCH_PROTOCOL.md
├── scripts/
│   └── fetch-klines.ts
├── src/
│   ├── alma.ts
│   ├── data-quality.ts
│   └── types.ts
└── tests/
    ├── alma.test.ts
    └── data-quality.test.ts
~~~

Raw data and results are written under the repository-level data/research/alma directory and are intentionally not committed. Every dataset must have a manifest and checksum before any experiment may consume it.

## SDK usage

The fetcher uses the package's public USDⓈ-M Futures endpoint:

~~~ts
import { BinanceClient } from '@nemesis-oss/binance-sdk';

const client = new BinanceClient({});
const bars = await client.futures.market.klines('SOLUSDT', '15m', {
  startTime,
  endTime,
  limit: 1000,
});
~~~

No API key is needed to read public klines. Do not add signed account, order, leverage or position calls to this workspace.

## Initial commands

Run tests:

~~~bash
npx tsx --test research/alma/tests/alma.test.ts research/alma/tests/data-quality.test.ts
~~~

Fetch a small smoke-test dataset first:

~~~bash
npx tsx research/alma/scripts/fetch-klines.ts --symbol SOLUSDT --timeframes 15m,1h,2h,4h,1d --days 90
~~~

The fetcher also supports the native Binance candle intervals listed in experiment.v1.json. Use the configured per-timeframe windows for a full collection; do not fetch the maximum dataset until the smoke test passes.

## Non-negotiable research rules

1. Raw candles are immutable inputs. A correction produces a new dataset version and checksum.
2. Remove the still-forming candle before indicator calculation or event detection.
3. Never silently sort, deduplicate, interpolate or forward-fill malformed data.
4. A signal evaluated at candle close can enter no earlier than the next candle's open.
5. Every MTF decision may use only the last fully closed bar for each timeframe at that decision timestamp.
6. All candidate combinations, rejected candidates, config hashes, data hashes and software revision must be recorded.
7. Use chronological train/validation/test splits, a purged gap, walk-forward evaluation and a locked final holdout.
8. Adjust for fees, slippage and historical funding before judging profitability.
9. Do not select parameters by win rate alone. Report expectancy, profit factor, drawdown, tail risk, trade count, exposure and stability by regime.
10. This is a research harness—not a live strategy or a recommendation to trade.

Next phase, only after data collection and quality checks: implement the event labels and a deterministic grid generator, then run the staged search defined in config/search-space.v1.json.