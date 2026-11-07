# Context Strategy Research — Run v83

**As of:** 2026-11-07T18:26:39.352Z  
**Classification:** `RESEARCH_BLOCKED`  
**Monitoring:** completed  
**Archive append:** completed and readback-verified  
**Experiments:** 0  
**Untouched OOS evaluations:** 0  
**OOS_VALIDATED entries:** 0  
**Trade decisions:** NO_TRADE for SOLUSDT, ETHUSDT and XRPUSDT

## 1. Research progress

### Completed this run
- Retrieved fresh Binance USDⓈ-M market data through the public market-data connector; SDK not used.
- Refreshed 16 rolling symbol/timeframe series (BTC, ETH, SOL, XRP × 5m/15m/1h/4h), 120 rows each: 1,904 completed and 16 forming bars excluded from signals.
- Appended **72 completed candles** to the remote raw archive:
  - 5m: 52 rows (13 per symbol)
  - 15m: 16 rows (4 per symbol)
  - 1h: 4 rows (1 per symbol)
  - 4h: 0 rows (the 16:00 UTC bar was still forming)
- Both raw deltas and manifests were fetched back and SHA-256 verified.
- Audited the remote backtest and conditional-edge source. No code was modified and no smoke test was run.

### Archive state
- Cumulative incremental rows: **3,988**.
- Latest completed high-water: 5m 18:20Z; 15m 18:00Z; 1h 17:00Z; 4h 12:00Z.
- 1h canonical base: 53,871 rows/symbol, 215,484 total, 2020-09-14T08:00Z through 2026-11-06T22:00Z; incremental high-water 2026-11-07T17:00Z.
- 4h canonical base: 13,461 rows/symbol, 53,844 total, canonical end 2026-11-05T16:00Z; incremental high-water 2026-11-07T12:00Z not merged.
- Multi-year 5m/15m archive remains absent. The 76-row delta remains unresolved; 13 manifest/page-symbol provenance mismatches remain.

Raw archive branch: `research/raw-ohlcv-archive-20261107T1823Z-run13`.

| Delta | Rows | SHA-256 |
|---|---:|---|
| `binance_usdm_delta_20261107T1823Z_5m15m1h_completed.jsonl` | 68 | `908c28435fc1175fcb83050045b7d966522a81ce84400300a839e0733479b0c0` |
| `binance_usdm_delta_20261107T1825Z_5m_completed.jsonl` | 4 | `9e9d15f0e3e0ea56cd7e9df7f644b662bd5aa2e05569b96643e9265ca15644df` |

## 2. Context discovery

No training-derived taxonomy fit, frequency/duration analysis, transition matrix or stability review was executed. Current labels are descriptive only.

### Current feature picture
- EMA20/EMA50 alignment: **15 of 16** symbol/timeframe cells BEAR; only SOL 5m is BULL.
- All 15m, 1h and 4h cells are BEAR.
- All four 5m EMA20 slopes are positive, but no current 5m series has a 20-bar breakout after the 18:20 UTC close.
- 5m ATR percentiles (recent 100 ATR values): BTC 14.1, ETH 18.2, SOL 0.0, XRP 1.0.
- 1h ATR percentiles: BTC 1.0, ETH 3.0, SOL 0.0, XRP 0.0.
- 4h ATR percentiles: BTC 69.7, ETH 61.6, SOL 61.6, XRP 89.9.

Interpretation: short-term countertrend stabilization/bounce inside bearish 15m–4h structure. This is not a validated regime probability. XRP has elevated recent 4h ATR percentile; no trained shock detector is available.

## 3. Strategy-context scorecard

No new experiment or OOS evaluation was run. Existing evidence is carried forward from the accessible v82 registry only.

| Candidate | Symbol/context | Stored status | Evidence |
|---|---|---|---|
| 4h Donchian20 breakout | SOLUSDT / BULL_LOW | OOS_PROMISING | 12 OOS trades; 66.7% win; 41.7% target-before-stop; +0.606R mean; PF 2.72; 1.3R max DD |
| Context-aligned Donchian20 WF v2 | 36 cells | INSUFFICIENT_EVIDENCE | Every cell below 100 OOS trades; nominal bootstrap intervals include zero; Holm-adjusted p=1.0 |
| Trend/pullback, breakout/retest, range mean reversion, failed-breakout fade, volatility expansion, BTC relative strength, funding/OI filters | all | HYPOTHESIS | Not tested in this run |

The stored SOL candidate's registry interval is [0.086R, 1.199R], labelled 95%, but its original experiment artifact, data/code hashes, seed and exact bootstrap settings are not attached. The current repository conditional-edge CLI defaults to 90% confidence; reconcile provenance before treating the stored interval as independently verified. The candidate remains OOS_PROMISING, not validated.

**OOS_VALIDATED = 0. REJECTED = 0.**

## 4. Key discoveries and engineering audit

### Market-context observations
- BTC/ETH/SOL/XRP are all bearish on 15m, 1h and 4h EMA alignment.
- 5m slopes have turned positive, but the completed 18:20 candle removed the earlier 20-bar breakout flags. There is no confirmed multi-timeframe reversal.
- 118 completed hourly returns produce contemporaneous BTC correlations: ETH 0.936, SOL 0.869, XRP 0.730. This is not lead/lag evidence.
- Last completed 4h relative returns: BTC -0.286%, ETH -0.357%, SOL -0.467%, XRP -1.220%.
- Current funding fields are below |0.05%|. PremiumIndex.lastFundingRate is recorded separately from the latest settled fundingRate history; BTC/ETH/SOL values differ between the two sources. A separate predicted funding rate was not exposed.
- OI changes versus the prior accessible snapshot are small: BTC -0.112%, ETH +0.010%, SOL +0.013%, XRP -0.004%. These do not establish crowding or liquidations.

### Repository code findings (remote source audit; not executed)
1. `scripts/backtest.ts` supports 15m/1h/4h only, despite ReplayService supporting 5m. Its kline mapper discards closeTime and does not explicitly filter forming bars; fetch calls have no explicit timeout.
2. `src/types.ts` Candle contains openTime/OHLCV only; closeTime is absent.
3. `src/backtesting/archiveKlines.ts` rejects volume < 0, so zero-volume candles pass although this research contract requires positive volume.
4. `scripts/conditional-edge.ts` consumes existing decision journals; it does not generate strategy trades from OHLCV. Defaults are minN=30 and 90% confidence.
5. Its CLI calls walkForward without requireSignificant=true; the walk-forward selector therefore uses raw ciLow>0 rather than requiring Holm-significant cells. The CLI also does not expose an embargo setting. Bootstrap clusters by UTC day, which does not model serial dependence across adjacent days.
6. No deterministic fixture was run. No local checkout exists; Node/npm are below the repository engine floor.

## 5. Current market snapshot

**Market endpoints retrieved:** mark/premium index, 24h ticker, open interest, best bid/ask, funding history/info, taker buy/sell volume and global long/short account ratio.

| Symbol | Mark | 24h change | OI | OI change vs prior snapshot | Top spread |
|---|---:|---:|---:|---:|---:|
| BTC (reference) | 75,806.10 | +0.032% | 96,157.967 | -0.112% | 0.0132 bps |
| ETH | 2,236.3509 | +0.495% | 2,367,063.785 | +0.010% | 0.0447 bps |
| SOL | 89.8118 | -0.510% | 9,373,290.23 | +0.013% | 1.1136 bps |
| XRP | 1.1622877 | -1.883% | 338,221,520.4 | -0.004% | 0.8605 bps |

Funding interval: 8h. Latest settled funding timestamp: 16:00Z. Next funding: 2026-11-08 00:00Z. No observed funding field exceeds the absolute 0.05% threshold. A separate predicted funding rate is unavailable.

## 6. Decisions

| Symbol | Decision | Reason |
|---|---|---|
| SOLUSDT | **NO_TRADE** | 5m EMA alignment is bullish but 15m/1h/4h remain bearish; no current breakout; no OOS_VALIDATED rule |
| ETHUSDT | **NO_TRADE** | 5m slope positive but EMA alignment and all higher timeframes bearish; no trigger or validated rule |
| XRPUSDT | **NO_TRADE** | Higher timeframes bearish; 4h ATR percentile 89.9; no breakout or validated rule |

BTC remains reference-only. No entry/stop/target/size is issued.

## 7. Mandatory preflight

| Check | Status | Evidence / impact |
|---|---|---|
| Shell/compute | PASS | Debian 13.3; 5 CPUs; 6.09 GB RAM; 30 GiB free |
| Local repo/runtime | BLOCKED | No checkout; Node 22.16.0/npm 10.9.2 vs required Node>=24/npm>=11 |
| Binance SDK | BLOCKED | `@nemesis-oss/binance-sdk`, `binance`, `@binance/connector`, `binance-api-node` not installed |
| Binance connectivity | DEGRADED | Connector data returned; direct DNS probe failed curl exit 6; raw HTTP statuses unavailable |
| Exchange metadata | BLOCKED | exchangeInfo serverTime stale by 111,968.601 seconds; not used for execution validation |
| Recent data quality | PASS | 16 series × 120; 1,904 completed/16 forming; zero quality failures |
| Long-history coverage | DEGRADED | Multi-year 5m/15m absent; 4h canonical merge incomplete |
| Backtest/smoke test | BLOCKED | Remote harness inspected, not locally invokable; smoke test NOT_RUN |
| Disk/storage | PASS | 30 GiB free; GitHub remote branches writable |
| Artifact readback | PASS | Both raw deltas/manifests SHA-256 verified |

## 8. Research queue and next actions

1. Backfill multi-year 5m/15m; merge incremental 4h; recover/quarantine the missing 76-row delta; reconcile 13 provenance mismatches.
2. Restore direct Binance DNS/HTTPS and fresh /time + /exchangeInfo; require <=60s drift and current TRADING status.
3. Provision Node>=24/npm>=11 and local checkout; fix closeTime, forming-bar exclusion, zero-volume validation, 5m support and request timeouts.
4. Repair conditional-edge evaluation: 95% CI, Holm-significant train selection, explicit embargo/purging and >=100 OOS trades per symbol/context; add a test that proves the gate is enforced.
5. Calibrate account fee tier, historical funding, spread, slippage, impact and latency.
6. Recover the stored SOL candidate's generating experiment artifact and exact data/code/seed/split/bootstrap provenance.
7. Only after these prerequisites, freeze one strategy × context × symbol experiment and evaluate on untouched chronological OOS.

**Daily research cycle: BLOCKED. Weekly taxonomy review: not due (next due 2026-11-11T00:00:00Z). No experiment was fabricated.**
