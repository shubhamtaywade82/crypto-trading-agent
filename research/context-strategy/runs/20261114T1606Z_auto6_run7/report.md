# Context Strategy Research — context-strategy-20261114T160628Z-auto6-run7

**As of:** 2026-11-14T16:06:28.837Z  
**Run classification:** MONITORING_ONLY  
**Strategy experiment:** BLOCKED_NO_EXECUTION  
**Untouched OOS:** NOT EVALUATED  
**Raw archive append:** 0 rows

## 1. Research progress

- Refreshed Binance USDⓈ-M market data for BTCUSDT (reference only) and ETHUSDT/SOLUSDT/XRPUSDT.
- Audited a rolling sample of 300 bars per symbol × interval across 5m/15m/1h/4h: 4,800 returned, 4,784 completed, 16 forming bars excluded. The 16 series passed timestamp continuity, grid, OHLC, finite-value, positive-volume and close-time checks.
- No raw bars were appended. The referenced archive branch is absent, so prior highwaters and indexes cannot be verified.
- No new strategy backtest, smoke test or OOS evaluation ran.
- The daily A1/A2 Layer A studies were completed earlier on 2026-11-14 and both failed their predeclared predictive gates. They are not strategy trade backtests.

## 2. Context discovery

Taxonomy v56 remains unchanged: 4h trend strength = (EMA20−EMA50)/Wilder ATR14; TRANSITION when absolute trend strength is below the per-symbol training q67; otherwise BULL/BEAR by sign. Volatility uses training q33/q67 of ATR14/close.

Current 4h labels: BTC, ETH, SOL and XRP are all BEAR_NORMAL. Trend confidence is high because 5m/15m/1h/4h EMA20<EMA50 and EMA50 slopes are negative. Volatility confidence is moderate, and lower for SOL because its ATR/close is only just above its training q33. Structure, BTC lead/lag and a training-calibrated shock flag are UNKNOWN/NOT_COMPUTED.

The latest weekly review (2026-11-12) used 13,461 aligned 4h bars per symbol from 2020-09-14 08:00Z through 2026-11-05 16:00Z. It found validation/test occupancy TVD: BTC 0.115, ETH 0.402, SOL 0.261, XRP 0.360; transition TVD: 0.130/0.415/0.277/0.367. Median test regime runs were 20h/16h/56h/32h respectively; median TRANSITION runs 26h/18h/104h/28h. Self-transition rates were 93.46%/91.88%/96.43%/93.16%. ETH and XRP show material drift; SOL is intermediate. Volatility training-threshold drift was approximately 31–43%. These are descriptive regime statistics, not win probabilities.

## 3. Strategy-context scorecard

Canonical registry v132 contains 5 SOL-specific entries and **zero OOS_VALIDATED entries**:

| Candidate | Context | OOS trades | Mean net R | 95% CI | Status |
|---|---|---:|---:|---:|---|
| Donchian20 breakout | Bull/low | 55 | +0.043 | [-0.280, +0.390] | INSUFFICIENT_EVIDENCE |
| Failed-breakout fade | Sideways/low | 113 | -0.148 | [-0.318, +0.020] | REJECTED |
| EMA20 pullback + BTC confirm | Bear/normal | 10 | -0.189 | Not promotion-grade | INSUFFICIENT_EVIDENCE |
| Volatility contraction breakout | Bull/compress | 18 | -0.205 | [-0.723, +0.295] | INSUFFICIENT_EVIDENCE |
| Volatility contraction breakout | Bear/compress | 26 | -0.115 | [-0.683, +0.371] | INSUFFICIENT_EVIDENCE |

The Donchian candidate's quote PnL per SOL was negative despite slightly positive mean R; its confidence interval crosses zero and its sample is below the 100-trade per-symbol/context floor. The failed-breakout fade failed net expectancy and profit-factor/risk gates. ETHUSDT and XRPUSDT have no symbol-specific validated entries. No evidence is transferred from SOL to ETH/XRP.

## 4. Key discoveries

- No OOS_VALIDATED edge exists for the current BEAR_NORMAL context on SOL, ETH or XRP.
- SOL SIDEWAYS_LOW failed-breakout fade is an actually tested REJECTED candidate; do not reuse it.
- SOL Bull/low Donchian20 is not validated; low OOS count, CI crossing zero and negative quote PnL block promotion.
- A1 and A2 each ran 111 trials with 12bp cost and 18bp stress cost. All four horizons failed the gate. A1 mean net returns ranged from -0.041% to -0.108%; A2 ranged from -0.100% to -0.214%. Their daily-cluster 80% lower bounds were negative. This is evidence against those feature sets under the current specification, not evidence that all strategy families fail.
- Do not retune A1/A2. The next strategy experiment must be independent and setup-specific.

## 5. Current context snapshot

| Symbol | 24h change | 4h context | MTF trend | OI 1h Δ | Taker buy/sell | Account long % | Funding indicated |
|---|---:|---|---|---:|---:|---:|---:|
| BTC (reference) | -4.420% | BEAR_NORMAL | Bearish 5m–4h | +0.091% | 0.922 | 75.00% | +0.003769% |
| ETH | -4.914% | BEAR_NORMAL | Bearish 5m–4h | +1.491% | 0.927 | 78.02% | -0.000286% |
| SOL | -7.974% | BEAR_NORMAL | Bearish 5m–4h | +0.246% | 0.948 | 78.58% | -0.002449% |
| XRP | -4.655% | BEAR_NORMAL | Bearish 5m–4h | -0.447% | 0.938 | 74.99% | +0.002537% |

Latest mark/ticker/book/OI timestamps are 16:06:16–16:06:33Z. Latest completed opens: 5m 16:00Z, 15m 15:45Z, 1h 15:00Z, 4h 12:00Z. Last funding settlement was 16:00Z; next funding is 2026-11-15 00:00Z; interval 8h. All observed indicated and settled funding magnitudes are below 0.05%.

The 1h taker buy/sell ratios are below 1 across all four symbols, indicating seller-dominant taker flow in the 15:00Z bucket. Account long ratios remain approximately 75–79%. This is a positioning snapshot only; it does not establish liquidation activity or a causal crowding edge.

## 6. Decision matrix

| Symbol | OOS_VALIDATED setup | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | Not evaluated | **NO_TRADE** | Registry has zero validated entries; current BEAR_NORMAL state is not an entry trigger. |
| ETHUSDT | None | Not evaluated | **NO_TRADE** | No symbol-specific validated entry; do not transfer SOL evidence. |
| XRPUSDT | None | Not evaluated | **NO_TRADE** | No symbol-specific validated entry; do not transfer SOL evidence. |

## 7. Preflight, data audit, costs and next actions

| Check | Status | Evidence / impact | Next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; ~4.7 GiB RAM; ~30 GiB free | Provision compatible runtime |
| Repo/code | DEGRADED | Remote main commit 27278d5 readable; no local checkout | Restore persistent checkout |
| Binance SDK | BLOCKED | SDK packages absent; Node/npm below engines | Do not claim SDK use |
| Network/endpoints | DEGRADED | Direct /time, /exchangeInfo, /klines, /premiumIndex, /openInterest, /ticker/24hr probes HTTP 000 due DNS; connector data returned | Restore DNS/HTTPS and fresh server time |
| Raw archive | BLOCKED | Archive branch missing/404; raw arrays absent on main | Recover exact immutable archive ref |
| Data quality | DEGRADED | Recent 4,800-row rolling sample clean; historical archive not re-audited | Reconcile full archive |
| Backtest/smoke test | BLOCKED | No local harness invocation; deterministic fixture not run | Node24/npm11 checkout, fixture twice, no-lookahead |
| Disk/storage | PASS | ~30 GiB free; GitHub main writable | Metadata-only persistence; no raw append |
| Artifact readback | NOT_CHECKED at preflight | Post-commit readback required | Verify exact Git blob identities |

Historical manifest v111 claims partial 5m/15m base history, 28 missing 1h opens per symbol plus an 8-row count discrepancy, and 4h raw/aligned/canonical counts 53,960/53,816/53,844 with 13 page-manifest SHA mismatches. These are manifest claims only; the raw archive branch and arrays were not accessible in this run.

Existing strategy results use a 15bp round-trip proxy; A1/A2 used 12bp fixed cost and 18bp stress. Neither is a calibrated account-specific execution model. Historical depth, market impact, latency, maker/taker fill probabilities and account fee tier remain unavailable. Current top-of-book spreads were approximately 0.015bp BTC, 0.055bp ETH, 1.365bp SOL and 1.033bp XRP; one snapshot does not calibrate realized execution costs.

**Next executable sequence:** recover archive branch and exact raw pages; reconcile page-0028 panel, 1h bridge and 4h hashes; provision Node>=24/npm>=11 and run deterministic smoke tests; backfill point-in-time derivatives and calibrate execution costs; then preregister one independent strategy×context×symbol experiment. Do not append raw rows or run strategy OOS before these gates pass.
