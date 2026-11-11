# Context Strategy Research Run - context-strategy-20261111T1926Z-auto32

**As of:** 2026-11-11T19:26:35.000Z  
**Run classification:** RESEARCH_EXECUTED (data-quality experiment only)  
**Untouched OOS:** NOT EVALUATED  
**Trade selection:** NO_TRADE for SOLUSDT, ETHUSDT and XRPUSDT

## 1. Research progress

- Appended 472 completed Binance USD-M OHLCV rows to a new archive branch.
- Coverage in this append: 5m 332 rows, 15m 108, 1h 28, 4h 4; 118 rows per symbol.
- Excluded 16 forming candles. All 16 series passed duplicate, gap, timestamp-grid, monotonicity, OHLC, positive-volume and finite-value checks. Cross-symbol timestamps aligned.
- Delta SHA-256 and manifest SHA-256 were recomputed after GitHub readback and matched.
- No strategy backtest, context refit, deterministic harness smoke test or untouched OOS evaluation ran.

## 2. Context discovery

The latest full 4h taxonomy artifact remains the 2026-11-03 context-discovery run: 13,449 common-window bars per symbol from 2020-09-14 04:00Z to 2026-11-03 12:00Z, split 8,069 train / 2,690 validation / 2,690 test per symbol. It classifies trend x volatility using EMA50/slope10 and training-only ATR14/close q33/q67.

Aggregate test frequencies: BEAR_LOW 32.93%, BULL_LOW 27.82%, BEAR_NORMAL 12.84%, TRANSITION_LOW 10.52%, BULL_NORMAL 6.51%, BEAR_HIGH 4.95%, TRANSITION_NORMAL 3.36%, BULL_HIGH 0.86%, TRANSITION_HIGH 0.21%. Median run lengths range from 2 bars for transition contexts to 5 bars for BEAR_LOW; BEAR_HIGH median is 10.5 bars but is rare. Combined context agreement under nearby feature definitions was 91.1%-93.6% by symbol.

This is context classification evidence, not trade-win probability. Same-bar BTC return correlation in the taxonomy (ETH 0.870, SOL 0.823, XRP 0.775) is contemporaneous correlation, not lead/lag evidence. The weekly taxonomy review is blocked pending canonical 4h page/hash reconciliation; thresholds were not refit this run.

## 3. Strategy-context scorecard

| Strategy / context | Symbol | Evidence | Validation trades | Validation expectancy (R) | 95% block-bootstrap CI |
|---|---:|---|---:|---:|---:|
| EMA20 reclaim / BULL_LOW | SOL | VALIDATION_ONLY | 34 | -0.178 | [-0.473, 0.186] |
| EMA20 reclaim / BEAR_LOW | SOL | VALIDATION_ONLY | 46 | 0.004 | [-0.327, 0.362] |
| EMA20 reclaim / BULL_LOW | ETH | VALIDATION_ONLY | 22 | -0.052 | [-0.440, 0.350] |
| EMA20 reclaim / BEAR_LOW | ETH | VALIDATION_ONLY | 16 | -0.130 | [-0.664, 0.483] |
| EMA20 reclaim / BULL_LOW | XRP | VALIDATION_ONLY | 19 | 0.132 | [-0.267, 0.519] |
| EMA20 reclaim / BEAR_LOW | XRP | VALIDATION_ONLY | 29 | 0.149 | [-0.328, 0.601] |

The untouched test period 2025-08-12 08:00Z to 2026-11-03 12:00Z remains RESERVED_NOT_EVALUATED. No OOS metrics exist for this strategy. All displayed validation confidence intervals cross zero. The prior registry v96 explicitly reports zero OOS_VALIDATED entries.

Other candidate families (breakout/retest, range mean reversion/failed-breakout fade, volatility expansion, BTC relative strength/lead-lag, funding/OI filters) remain HYPOTHESIS or INSUFFICIENT_EVIDENCE; no new strategy test ran.

## 4. Key discoveries

- The taxonomy is dominated by low-volatility directional contexts, but that frequency does not demonstrate a conditional trading edge.
- EMA20 reclaim pullback is not validated: SOL/ETH validation expectancy is negative or near zero; XRP is modestly positive but highly uncertain. No cell meets the >=100 OOS-trade gate.
- There is no demonstrated OOS edge in the accessible registry. Do not infer one from current regime or 24h returns.

## 5. Current context snapshot

Snapshot retrieval: 2026-11-11 19:26Z. Latest completed 4h candle opened 12:00Z and closed 15:59:59Z; the 16:00Z candle is forming and excluded.

| Symbol | 4h context | ATR14/close | EMA50 slope10 | Lower-timeframe alignment |
|---|---|---:|---:|---|
| BTC (reference) | BEAR_LOW | 1.219% | -1.145% | 15m BULL; 1h/5m TRANSITION |
| ETH | BEAR_LOW | 1.781% | -2.494% | 15m BULL; 1h BEAR; 5m TRANSITION |
| SOL | BEAR_LOW | 1.968% | -2.583% | 15m BULL; 1h TRANSITION; 5m BEAR |
| XRP | BEAR_NORMAL | 2.215% | -3.470% | 15m TRANSITION; 1h/5m BEAR |

All four 4h structures are inside their prior 20-bar ranges. ETH is close to its training q33 volatility boundary. The 15m countertrend bounce in BTC/ETH/SOL is a transition warning, not a reversal confirmation.

Funding interval is 8h for all four. Premium-index lastFundingRate fields: BTC 0.004282%, ETH 0.006467%, SOL 0.002627%, XRP 0.006763%. Latest settled rates at 16:00Z: BTC 0.006639%, ETH 0.006582%, SOL 0.008936%, XRP 0.010000%. All are below the 0.05% absolute threshold. Next funding is 00:00Z on 2026-11-12.

Top-of-book spreads: BTC 0.0135 bps, ETH 0.0481 bps, SOL 1.1811 bps, XRP 0.9455 bps. These are current snapshots, not historical execution-cost estimates. OI and account long/short ratios do not establish crowding or liquidation pressure.

## 6. Decisions

| Symbol | Eligible OOS_VALIDATED strategy | Trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | No validated rule to evaluate | NO_TRADE |
| ETHUSDT | None | No validated rule to evaluate | NO_TRADE |
| XRPUSDT | None | No validated rule to evaluate | NO_TRADE |

No entry, stop, target or size is emitted. The regime is not an entry trigger. Fresh exchange metadata is blocked and historical execution costs are not calibrated.

## 7. Preflight, audit and next work

- Shell: Linux x86_64, Python 3.13.5, Node 22.16.0, npm 10.9.2, 3 CPUs, about 5.8 GiB RAM, 30 GiB free disk. No local repo, Docker, pnpm/yarn or Binance SDK.
- Repository source is remotely accessible, but its package requires Node >=24/npm >=11; the local runtime is below that floor.
- Direct Binance REST probes returned HTTP 000 because DNS resolution failed. Binance connector data calls succeeded, but connector HTTP status/headers are not exposed.
- Connector exchangeInfo serverTime was 2026-11-11 10:18:31.943Z, 32,860.057 seconds behind the 19:26:12Z mark timestamp; contract-status validation is BLOCKED.
- The 4h common sample is multi-year. Full common-start 5m/15m/1h coverage is not verified. Historical fee tier, spread, slippage, latency, market impact and funding cashflows are unavailable.
- Next priority: restore fresh metadata/time; reconcile 4h BTC page hashes and 44 unmatched early rows; audit/backfill 1h/15m/5m; obtain measured costs; mount Node >=24/npm >=11 and run the actual fixture/harness; only then run frozen strategy x context x symbol walk-forward experiments.

**Persistence:** raw delta, manifest and checksum are on this branch. Research snapshots in this run folder are separate artifacts; readback verification is recorded in the companion verification file.
