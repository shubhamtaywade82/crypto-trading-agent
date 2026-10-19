# ALMA / multi-timeframe research workspace

**Status:** Phase 0 validated (typecheck clean, 37/37 unit tests). Phase 1 event labels + deterministic stage-1 grid generator + event-study CLI implemented and smoke-tested offline. Real-data ingestion pending — run the fetch locally (see below).
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
├── reports/
│   └── examples/           # committed example report (synthetic smoke run)
├── scripts/
│   ├── event-study.ts
│   ├── fetch-klines.ts
│   ├── sweep-study.ts
│   ├── sweep-eval.ts
│   └── sweep-eval-stagec.ts
├── src/
│   ├── alma.ts
│   ├── atr.ts
│   ├── data-quality.ts
│   ├── eval-lib.ts
│   ├── events.ts
│   ├── grid.ts
│   ├── sweeps.ts
│   ├── trade-sim.ts
│   └── types.ts
└── tests/
    ├── alma.test.ts
    ├── atr.test.ts
    ├── data-quality.test.ts
    ├── events.test.ts
    └── grid.test.ts
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

On networks where Binance's API hosts are unreachable or IP-banned (common on cloud sandboxes), pass an explicit base:

~~~bash
npx tsx research/alma/scripts/fetch-klines.ts --symbol SOLUSDT --timeframes 15m --days 30 --api-base https://fapi.binance.com
~~~

## Initial commands

Type-check the isolated workspace:

~~~bash
npx tsc --noEmit -p research/alma/tsconfig.json
~~~

Run tests:

~~~bash
npx tsx --test research/alma/tests/alma.test.ts research/alma/tests/data-quality.test.ts research/alma/tests/atr.test.ts research/alma/tests/events.test.ts research/alma/tests/grid.test.ts
~~~

Fetch a small smoke-test dataset first:

~~~bash
npx tsx research/alma/scripts/fetch-klines.ts --symbol SOLUSDT --timeframes 15m,1h,2h,4h,1d --days 90
~~~

The fetcher also supports the native Binance candle intervals listed in experiment.v1.json. Use the configured per-timeframe windows for a full collection; do not fetch the maximum dataset until the smoke test passes.

## Event study (Phase 1/2)

Once snapshots exist locally, run descriptive event statistics for the three
predeclared event families (`cross_only`, `cross_with_slope`,
`cross_then_pullback_then_reject`). Outcomes are direction-adjusted forward
returns from the next bar's open over a fixed horizon, with MFE/MAE, tail
exclusion, and a long-drift baseline for context:

~~~bash
npx tsx research/alma/scripts/event-study.ts \
  --symbol SOLUSDT --timeframes 15m,1h,2h,4h,1d \
  --fast 9 --slow 21 --offset 0.85 --sigma 6 --source close \
  --atr 14 --horizon 6 --invert-control
~~~

Key options: `--line fast|slow` chooses the pullback reference line;
`--require-slow-slope true|false`; `--extend-atr`, `--touch-tol-atr`,
`--max-bars-after-cross` are the pullback thresholds; `--invert-control` adds
the inverted-direction negative control. Reports are written under
`data/research/alma/events/` and include the dataset manifest SHA-256s. A
committed synthetic example lives in `reports/examples/`.

The stage-1 grid generator (`src/grid.ts`) enumerates the predeclared
coarse space deterministically: 112 valid fast<slow length pairs × 6 offsets ×
7 sigmas × 2 sources × 15 native timeframes = **141,120 planned candidates**
(see `tests/grid.test.ts`). Candidate counts are plan sizes, not completed
experiments.

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

Next phase, only after real data collection passes: run the event study across all timeframes, then implement the staged search runner over `src/grid.ts` with walk-forward splits and Holm correction per docs/RESEARCH_PROTOCOL.md Phases 2-6.

## Phase status

- [x] Phase 0a — workspace, data contract, SDK pin, fetcher with manifests and validation
- [x] Phase 0b — ALMA/ATR/event-label/grid unit tests (37 passing), typecheck clean
- [x] Phase 1 — event definitions fixed in code before any result inspection
- [x] Offline pipeline smoke test (synthetic deterministic fixture, inverted control behaves as expected)
- [x] Real-data ingestion (fapi IP-banned in sandbox; data.binance.vision archive path with manifests, 730d + train/test windows)
- [x] Stage A (sweep family) — sweep-and-reclaim definitions committed before results (`sweep-study.ts`); 730d multi-regime descriptive study with train/test split
- [x] Stage B (cost-adjusted) — predeclared 24-config trade family committed before results (`sweep-eval.ts`, `src/trade-sim.ts`); verdict: rejected, no Holm-significant config
- [x] Stage C (wider-stop family) — predeclared 30-config short-side family + train/confirmation gates committed before results (`sweep-eval-stagec.ts`, `src/eval-lib.ts`); train-first, survivors must also pass the untouched test window and a fresh earlier-history replication window
- [ ] Phase 2 — stage-1 grid run on real data
- [ ] Phases 3-6 — refinement, MTF topology, execution model, promotion gate