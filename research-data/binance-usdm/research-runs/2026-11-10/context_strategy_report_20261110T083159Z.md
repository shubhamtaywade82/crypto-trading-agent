# Context Strategy Research — v96

**As of:** 2026-11-10 08:31:59 UTC (14:01:59 IST)  
**Run classification:** `RESEARCH_EXECUTED` — incremental archive integrity only  
**Strategy backtest:** `BLOCKED`  
**Untouched OOS:** `NOT_EVALUATED`  
**OOS_VALIDATED strategies:** `0`

## Executive result

Appended **692 completed Binance USDⓈ-M klines** across BTC/ETH/SOL/XRP and 5m/15m/1h/4h. Sixteen forming bars were excluded. All incremental-window checks passed; the raw delta, manifest and four interval indexes were read back and verified. No strategy experiment, backtest smoke test or OOS evaluation ran. SOL, ETH and XRP remain **NO_TRADE**.

## 1. Research progress

| Interval | Rows appended | First completed open | Last completed open |
|---|---:|---|---|
| 5m | 480 | 2026-11-09 22:30Z | 2026-11-10 08:25Z |
| 15m | 160 | 2026-11-09 22:30Z | 2026-11-10 08:15Z |
| 1h | 40 | 2026-11-09 22:00Z | 2026-11-10 07:00Z |
| 4h | 12 | 2026-11-09 20:00Z | 2026-11-10 04:00Z |
| **Total** | **692** | | |

Per symbol: 173 rows each. Fetched 708 rows, excluded 16 forming rows, excluded zero pre-highwater rows. Duplicate, gap, off-grid, non-monotonic, OHLC, non-positive-volume, non-finite and close-time failures were all zero. Cross-symbol timestamp alignment passed on all four intervals.

Raw delta SHA-256: `5a0efc90d400e19f5494771359c0590ce79f3ea5f0736f1dba778733b3009711`  
Manifest SHA-256: `4b90ad960cc2e8f9324d92da30f6ae6b69d50f87eeb391651dbb3ccd6b2aa5e2`  
GitHub readback: exact content and SHA-256 match. All four index updates were read back exactly.

## 2. Context discovery

No taxonomy refit this run. The carried-forward v56 taxonomy uses 4h trend strength `(EMA20-EMA50)/Wilder ATR14`, training-only q67 transition threshold, training-only q33/q67 volatility thresholds, 500-bar warmup and 70/15/15 chronological split.

Prior v95 classification was adequate for descriptive 4h occupancy but insufficient for strategy-edge or multi-timeframe generalization. ETH/XRP showed material validation/test context drift. These are feature-state frequencies, not win probabilities. Current snapshot is descriptive only; no training thresholds were refit.

## 3. Strategy-context scorecard

- **OOS_VALIDATED:** 0 entries.
- **Context-aligned Donchian20 WF v2:** `INSUFFICIENT_EVIDENCE` across 36 cells; all below 100 OOS trades/cell, block-bootstrap interval includes zero, Holm-adjusted p=1.0; 15bp round-trip proxy is not a calibrated execution model.
- **SOLUSDT / BULL_LOW / 4h Donchian20:** `OOS_PROMISING`, 12 OOS trades, 66.7% win rate, 41.7% target-before-stop, mean net +0.606R, PF 2.72, max drawdown 1.3R, block-bootstrap 95% CI [0.086, 1.199]. Not actionable: sample far below 100 trades and robustness/cost gates incomplete.
- Trend/pullback, breakout/retest, range mean reversion, failed-breakout fade, volatility expansion, BTC relative strength and funding/OI filters remain `HYPOTHESIS`.

No status transition this run.

## 4. Key discoveries

The new result is a clean incremental data window, not a strategy edge. No strategy-context-symbol cell gained evidence. Current 1h taker flow is mixed: BTC buy-dominant, ETH sell-dominant, SOL and XRP slightly buy-dominant, while top-five order-book imbalance is negative for BTC/ETH/SOL and mildly positive for XRP. This divergence is not a standalone signal.

## 5. Current context snapshot

Kline sample: 16 series × 120 bars = 1,920 returned; 1,906 completed and 14 forming excluded. All four symbols are below EMA20 and EMA50 with EMA20 < EMA50 across 5m/15m/1h/4h. BTC 5m and XRP 15m have slightly positive 10-bar EMA50 slopes, but alignment remains bearish. Higher-timeframe bearish alignment is the strongest descriptive feature; volatility classes are unassigned because training thresholds were not refit.

- BTC reference: mark 74,641.8; 24h +0.663%.
- ETH: mark 2,112.45; 24h +0.217%.
- SOL: mark 85.71; 24h -0.764%.
- XRP: mark 1.0903; 24h -0.402%.

Funding history shows last settlement at 08:00Z and next funding at 16:00Z (8-hour interval). The premium-index `lastFundingRate` field is the latest funding-rate field, not a verified next-settlement forecast; current indicated next-settlement rate is unavailable from this REST snapshot. All observed latest and settled rates are below 0.05% in absolute value.

## 6. Decisions

| Symbol | OOS_VALIDATED strategy | Trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | Not evaluated; no validated rule | **NO_TRADE** |
| ETHUSDT | None | Not evaluated; no validated rule | **NO_TRADE** |
| XRPUSDT | None | Not evaluated; no validated rule | **NO_TRADE** |

No entry/stop/target levels are emitted. A bearish context is not an entry trigger.

## 7. Preflight, blockers and next actions

| Check | Status | Evidence / impact | Next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13 x86_64; Node 22.16.0; npm 10.9.2; 5 cores; ~4.94GB available RAM; ~30GB free disk | Provision Node >=24/npm >=11 |
| Repo/code | BLOCKED | No local checkout; remote main HEAD 669ba233 | Clone exact commit locally |
| Binance SDK | BLOCKED | SDK packages not importable; no node_modules | Install only after compatible checkout |
| Network/Binance | DEGRADED | Connector market data works; direct DNS/HTTPS to fapi.binance.com and data.binance.vision times out; connector does not expose HTTP status | Restore egress or use verified network-enabled runner |
| Exchange metadata | BLOCKED for execution | exchangeInfo serverTime 01:01:01.895Z vs market data 08:30:18Z (26,956.105s drift) | Require fresh time/metadata before execution |
| Raw historical archive | DEGRADED | 1h base 215,484 rows from 2020-09-14; 4h canonical 53,844 rows through 2026-11-05 16:00Z; 5m/15m base absent | Backfill 5m/15m and reconcile 4h |
| Data quality | PASS for new delta; DEGRADED overall | 692-row append has zero failures; full archive/provenance not fully reconciled | Full archive audit after backfill |
| Backtest harness/smoke test | BLOCKED | Node floor unmet, repo absent; main code drops closeTime, permits zero volume, omits 5m and defaults to BTCUSDT | Fix contract/loader/validator/universe and run deterministic fixture |
| Storage/readback | PASS | GitHub branch writes and exact readback verified | Continue atomic append and hash verification |

### Research queue

1. **P0:** provision Node 24/npm 11 and local checkout.
2. **P0:** fix candle closeTime/positive-volume/5m/BTC-reference defects and add deterministic fixture tests.
3. **P1:** backfill multi-year 5m/15m history.
4. **P1:** reconcile 4h raw/aligned/canonical counts and page-level provenance.
5. **P1:** archive historical funding and calibrate fee/spread/slippage/fill assumptions.
6. **P2:** refit context taxonomy using training-only thresholds after data prerequisites pass.
7. **P2:** freeze and execute a strategy × context × symbol experiment with purge/embargo, block bootstrap and Holm correction.

**Status:** `RESEARCH_EXECUTED` for the data-quality experiment. `OOS_EVALUATED` not achieved. No strategy is actionable.
