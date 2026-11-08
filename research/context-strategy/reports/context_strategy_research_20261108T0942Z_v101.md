# Context-conditioned strategy research — 2026-11-08 09:42 UTC

**Run status: RESEARCH_BLOCKED**  
Archive maintenance and current-market classification completed. No new strategy experiment, repository smoke test, or untouched OOS evaluation was executed.

## Preflight

| Capability | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell / compute | PASS | Linux 6.18.57, Python 3.13.5, 5 CPUs, 6,090,668 kB RAM, 4,924,672 kB available, 29.83 GiB free | Bounded archive processing ran. |
| Repository / code | DEGRADED | Remote GitHub repo accessible; local checkout absent at `/home/oai`; remote `scripts/backtest.ts` exists | Provision local checkout before running harness. |
| Node / SDK | BLOCKED | Node 22.16.0, npm 10.9.2; required Node >=24/npm >=11; common Binance SDK packages absent; pnpm/yarn permission denied | No SDK used. Install compatible runtime and pinned package. |
| Binance direct network | DEGRADED | Direct DNS probes for `/time`, `/exchangeInfo`, `/klines`, `/premiumIndex`, `/openInterest`, `/ticker/24hr` failed with temporary name-resolution errors | Connector supplied current data, but HTTP status/headers unavailable. Restore DNS/egress. |
| Exchange metadata | BLOCKED | Connector `exchangeInfo.serverTime=2026-11-06T11:18:40.878Z`; fresh mark time 2026-11-08 09:38:59Z; drift 166,818.122s (46h20m18s) | Last-known contract status is stale and not execution-valid. Require <=60s drift. |
| Raw historical archive | DEGRADED | 1h/4h multi-year canonical archives exist; multi-year 5m/15m history absent; canonical 4h ends Nov 5 16:00Z | Rebuild canonical 4h, reconcile row counts, backfill 5m/15m. |
| Data quality / coverage | DEGRADED | Recent samples across all symbols/timeframes and appended ranges show zero duplicates, gaps, OHLC violations, non-positive volume, non-finite values or off-grid timestamps | Recent data is clean; historical coverage is still inadequate. |
| Backtest harness / smoke test | BLOCKED | Remote `scripts/backtest.ts` not invoked; repository fixture smoke test NOT_RUN | No new experiment and no OOS evaluation this run. |
| Disk / storage | PASS | 29.83 GiB free; remote GitHub branch writes succeeded | Persistent remote archive/queue used. |
| Artifact readback | PASS | New delta files, manifests, archive indexes and queue were fetched after writes; row counts and SHA-256 declarations checked | Archive and queue persistence verified. |

Direct official REST probes all returned **UNAVAILABLE** due DNS resolution. Connected Binance actions returned current data, but raw HTTP status/headers were not exposed.

## 1. Research progress

- Created raw archive branch: `research/raw-ohlcv-archive-20261108T0927Z-run23`.
- Appended **152 completed bars** across four symbols: 5m 104, 15m 36, 1h 8, 4h 4; 38 rows/symbol.
- Excluded 24 forming candles. Appended-range checks: 0 duplicates, 0 gaps, 0 OHLC failures, 0 non-positive volume, 0 non-finite values, 0 off-grid timestamps.
- Archive index total incremental rows: **5,016**. Latest completed opens: 5m 09:30Z, 15m 09:15Z, 1h 08:00Z, 4h 04:00Z.
- Canonical 4h remains 13,461 rows/symbol through 2026-11-05 16:00Z; canonical 1h remains 53,871 rows/symbol through 2026-11-06 22:00Z. 1h incremental high-water is 08:00Z.
- The previously missing 76-row delta is now restored and hash/readback verified. All four canonical 4h hashes and manifest consistency checks pass. Remaining raw-vs-canonical differences: BTC/ETH/XRP +38 rows each; SOL -6 rows.
- No new strategy experiment or OOS evaluation ran. Exact blockers: no local repo checkout, Node/npm below package floor, no SDK, direct Binance DNS unavailable, no multi-year 5m/15m archive, and repository smoke test not run.

## 2. Context discovery

Taxonomy: `CTX-4H-EMA50xEMA200-ATRQ-v2-FULL-ARCHIVE`. The 4h context-distribution artifact uses 13,461 canonical bars/symbol, labels 12,462 after a 999-bar warmup, and uses a 60/20/20 chronological diagnostic split (7,077 / 2,692 / 2,693). Thresholds were carried forward from the training-derived taxonomy; **no threshold refit occurred this run**.

| Symbol | Most frequent contexts | Shock frequency | Overall self-transition | Train/test JSD |
|---|---|---:|---:|---:|
| BTC | SIDEWAYS_LOW 25.56%; BULL_LOW 16.05%; BEAR_HIGH 11.79% | 0.634% (79 bars) | 93.03% | 0.20203 |
| ETH | SIDEWAYS_LOW 18.58%; BULL_NORMAL 16.24%; BEAR_HIGH 14.03% | 0.746% (93 bars) | 92.64% | 0.10765 |
| SOL | SIDEWAYS_LOW 24.77%; BEAR_LOW 12.86%; BULL_NORMAL 11.86% | 0.586% (73 bars) | 92.38% | 0.29652 |
| XRP | SIDEWAYS_LOW 18.86%; BEAR_LOW 17.12%; BEAR_NORMAL 14.23% | 0.554% (69 bars) | 92.91% | 0.12844 |

- Context persistence is high: common self-transition probabilities are 95.6–97.1% for SIDEWAYS_LOW and 94.1–96.2% for several low-volatility trend states.
- Median BEAR_LOW run duration: BTC 4 bars, ETH 8, SOL 7, XRP 14. Shock runs have median duration 1 bar.
- SOL and BTC have the largest train/test distribution shifts (JSD 0.29652 and 0.20203). This weakens generalization claims.
- Shock samples are only 69–93 bars/symbol; insufficient for independent strategy inference.
- Frequencies/durations/transitions describe feature states, not the probability of a profitable trade. The distribution artifact ends at Nov 5 16:00Z; incremental bars are not merged into those historical counts.

## 3. Strategy-context scorecard

Registry snapshot: 5 entries; 1 REJECTED, 4 INSUFFICIENT_EVIDENCE, **0 OOS_VALIDATED**. No ETH or XRP strategy entries.

| Symbol / context | Candidate | Status | OOS trades | Win rate | Target before stop | Mean net R (95% block CI) | PF | Max DD |
|---|---|---|---:|---:|---:|---:|---:|---:|
| SOL / SIDEWAYS_LOW | Failed-breakout fade v1 | REJECTED | 113 | 43.36% | 27.43% | -0.148 [-0.3175, 0.0196] | 0.787 | 20.79R |
| SOL / BULL_LOW | Donchian20 breakout v1 | INSUFFICIENT_EVIDENCE | 55 | 43.64% | 21.82% | +0.043 [-0.28, 0.39] | 1.082 | 7.89R |
| SOL / BEAR_NORMAL | EMA20 pullback + BTC confirm v1 | INSUFFICIENT_EVIDENCE | 10 | 40.00% | 10.00% | -0.189 [-0.86, 0.779] | 0.733 | 3.48R |
| SOL / BULL_COMPRESS | Vol-contraction breakout + BTC confirm v1 | INSUFFICIENT_EVIDENCE | 18 | 33.33% | 11.11% | -0.205 [-0.723, 0.295] | 0.687 | 7.43R |
| SOL / BEAR_COMPRESS | Vol-contraction breakout + BTC confirm v1 | INSUFFICIENT_EVIDENCE | 26 | 34.62% | 19.23% | -0.115 [-0.536, 0.308] | 0.814 | 7.81R |

The failed-breakout fade also had average win 1.005R, average loss -1.031R, quote PnL -26.58 per SOL, exposure 13.36%, and Holm-adjusted p=1.0. Donchian20 had negative quote PnL (-19.83 per SOL) despite its small positive mean R. The combined volatility-contraction sample had 44 OOS trades, mean -0.152R and PF 0.760 versus a simple baseline mean -0.099R and PF 0.835.

Costs are inconsistent across prior experiments: failed-breakout/Donchian use 13.5 bps round-trip; pullback 15 bps; volatility-contraction 21.5 bps. Several experiments set funding cost to zero because historical funding was unavailable. Fixed slippage/spread are not empirical fill models. Cross-strategy ranking is therefore not apples-to-apples.

## 4. Key discoveries

1. SOL failed-breakout fade in SIDEWAYS_LOW is rejected on actual OOS evidence: negative expectancy, PF below 1 and 20.79R drawdown.
2. SOL volatility-contraction breakout is negative in both compress contexts; both CIs cross zero and Holm-adjusted p=1.0.
3. SOL Donchian20 in BULL_LOW has a positive point estimate but negative quote PnL and wide uncertainty; insufficient evidence.
4. EMA20 pullback has only 10 OOS trades; insufficient evidence.
5. No ETH/XRP evidence exists. No cross-symbol transfer is permitted.
6. No context is labelled intrinsically untradeable. Shock states are too sparse to test independently.

## 5. Current context snapshot

Snapshot as of 2026-11-08 09:39 UTC. Contexts use the latest completed 4h candle (open 04:00Z); 1,499 completed 4h bars were fetched for each symbol. The 1h taker-flow window uses the last 12 completed 5m candles (08:35–09:30Z).

| Symbol | Mark / last | 24h change | 24h high–low | OI | Indicated funding | Last settled funding | Top spread | 4h context | EMA50/200 spread | ATR14/close | 4h vol / prior-20 median | 1h taker buy share |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| BTC | 75,889.60 / 75,881.20 | -0.254% | 76,094–75,526.90 | 96,030.419 | 0.00542% | 0.007157% | 0.0132 bps | BEAR_LOW (reference) | -2.9244% | 0.9564% | 0.252 | 46.53% |
| ETH | 2,236.3433 / 2,236.35 | -0.388% | 2,248.10–2,221.45 | 2,374,469.62 | 0.00784% | 0.01000% | 0.0447 bps | BEAR_LOW | -3.9574% | 1.2535% | 0.239 | 48.91% |
| SOL | 89.26 / 89.23 | -0.867% | 90.11–88.67 | 9,404,423.99 | 0.006808% | 0.005796% | 1.1204 bps | BEAR_LOW | -7.4160% | 1.5927% | 0.384 | 43.46% |
| XRP | 1.1634 / 1.1631 | -0.632% | 1.1731–1.1477 | 334,826,998.9 | 0.008736% | 0.01000% | 0.8596 bps | BEAR_LOW | -5.5744% | 1.7906% | 0.392 | 48.34% |

- All indicated and last-settled funding values are below 0.05%; no high-funding flag. Funding interval is 8 hours; last settlement 08:00Z, next funding 16:00Z.
- Taker buy share is below 50% for all four symbols over the last hour; no broad aggressive-buy confirmation.
- BTC is near the sideways trend boundary (0.42 percentage points); XRP ATR14/close is near q33 (0.20 percentage points). Both carry transition warnings.
- ETH/SOL have no threshold-proximity warning. All four are below the frozen shock threshold.
- OI is a point-in-time level only; no OI change or crowding inference is made. Top-of-book spread is not full depth.

## 6. SOL / ETH / XRP decision matrix

| Symbol | Eligible OOS_VALIDATED strategy | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOL | None | Not evaluated | **NO_TRADE** | Zero validated registry entries; current BEAR_LOW state has no proven SOL setup; taker buy share 43.46%; low 4h volume ratio; metadata stale. |
| ETH | None | Not evaluated | **NO_TRADE** | No ETH-specific OOS evidence or validated trigger; current BEAR_LOW state only; taker buy share 48.91%; metadata stale. |
| XRP | None | Not evaluated | **NO_TRADE** | No XRP-specific OOS evidence; BEAR_LOW near volatility boundary; taker buy share 48.34%; top spread 0.8596 bps; metadata stale. |

No entry, stop or target levels are emitted because no validated setup exists.

## 7. Data audit, costs, unavailable inputs, risks and next experiments

**Source endpoints / fields used through the connected Binance actions:** `/fapi/v1/klines` (5m/15m/1h/4h OHLCV and taker-buy volume), `/fapi/v1/premiumIndex` (mark/index/lastFundingRate/nextFundingTime), `/fapi/v1/fundingRate` (last settled funding), `/fapi/v1/fundingInfo` (8h interval), `/fapi/v1/openInterest`, `/fapi/v1/ticker/24hr`, `/fapi/v1/ticker/bookTicker`, and `/fapi/v1/exchangeInfo`. Direct `/time` and all six direct REST probes failed DNS.

**Unavailable:** multi-year 5m/15m archive; historical funding for BTC/ETH/XRP; historical OI, taker, depth and positioning series; full depth snapshots; liquidations; long/short positioning ratios; fresh direct exchange server time.

**Risks:** stale contract metadata; incomplete 5m/15m history; canonical 4h not rebuilt through latest delta; raw/canonical row-count mismatch; incomplete page-level provenance reconciliation; incomplete derivatives history; no repository smoke test; inconsistent cost models and missing historical funding in some tests.

**Next actions (priority order):**
1. Rebuild canonical 4h through 2026-11-08 04:00Z from verified deltas; verify row counts and hashes.
2. Reconcile raw/canonical row differences: BTC/ETH/XRP +38 each; SOL -6; audit page-level provenance.
3. Backfill multi-year 5m/15m history for all four symbols.
4. Restore direct Binance DNS; require fresh /time and /exchangeInfo with <=60s drift.
5. Provision Node24/npm11, local repository checkout and pinned SDK; run deterministic fixture smoke test.
6. Standardize fees/spread/slippage/funding, then replicate frozen strategy experiments on ETH/XRP only after prerequisites pass.
7. Weekly taxonomy stability review due 2026-11-11; no threshold refit was performed this run.

**Registry:** 5 entries (1 REJECTED, 4 INSUFFICIENT_EVIDENCE), 0 OOS_VALIDATED. Registry unchanged this run. Research queue updated and persisted.
