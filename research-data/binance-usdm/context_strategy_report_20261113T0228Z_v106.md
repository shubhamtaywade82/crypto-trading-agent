# Binance USDⓈ-M Context Strategy Research — v106

**Run:** `context-strategy-20261113T022803Z-auto11-v106`  
**As of UTC:** `2026-11-13T02:28:03.722Z`  
**Classification:** `RESEARCH_BLOCKED` — monitoring and a 232-row raw delta completed; no strategy experiment or OOS evaluation.  
**Universe:** BTCUSDT reference only; SOLUSDT, ETHUSDT, XRPUSDT tradable.

## 1. Research progress

- **Monitoring:** 200 klines per symbol × interval, 4 symbols × 4 intervals = **3,200 rows fetched**; **3,184 completed**, **16 forming excluded**. All 16 series passed current-window integrity checks.
- **Raw data persisted:** **232 completed bars** were written as a separate GitHub delta and read back. SHA-256 `93fb878cbf2095212c18a686dd2f589fbc91615759fd0be44cd20420cd94b2bd`; 5m=164, 15m=52, 1h=12, 4h=4; 58 per symbol.
- **Canonical archive:** interval indexes and canonical highwaters were **not** changed. The delta is preserved but not integrated into canonical indexes because the index files contain duplicated alias fields and unresolved 1h/4h row-count/provenance defects.
- **Experiments:** 0. **OOS evaluations:** 0. No promotion, downgrade or rejection.
- **Persistent snapshots:** v106 registry, queue, market snapshot, archive manifest and report are stored on the research branch and readback-verified. Raw delta and delta manifest SHA-256 readback checks also passed.

## 2. Context discovery

No taxonomy refit was run. The carried-forward v56 hypothesis uses 4h trend strength `(EMA20−EMA50)/Wilder ATR14`, training-only q67 trend-transition threshold, training-only q33/q67 ATR/close volatility buckets, 70/15/15 chronological split and 500-bar warmup. Fitted threshold values and the transition matrix are unavailable.

The current monitoring classifier is simpler: EMA20/EMA50 alignment plus 10-bar EMA20 slope, computed from completed candles. It is descriptive, not a train-fitted regime detector. All four symbols are bearish on 5m/15m/1h/4h. Frequency, duration, transition probabilities, classification stability and calibrated classification confidence remain unavailable. No win probability is inferred.

## 3. Strategy-context scorecard

| Candidate | Symbol/context | Evidence carried forward | Status | Current applicability |
|---|---|---|---|---|
| Donchian20 4h breakout walk-forward v2 | 36 symbol/context cells | All below 100 OOS trades; nominal block-bootstrap intervals include zero; Holm-adjusted p=1.0; 15 bp proxy uncalibrated | `INSUFFICIENT_EVIDENCE` | Not actionable |
| Donchian20 4h breakout | SOLUSDT / BULL_LOW | 12 OOS trades; 66.7% win; 41.7% target-before-stop; +0.606R mean net; PF 2.72; 1.3R max DD; reported 95% block-bootstrap CI [+0.086R,+1.199R] | `OOS_PROMISING` | Research-only; below sample/cost/robustness gates |
| Trend/pullback continuation | ALL | Not independently tested | `HYPOTHESIS` | Not eligible |
| Breakout/retest / volatility contraction | ALL | Not independently tested | `HYPOTHESIS` | Not eligible |
| Range mean reversion / failed-breakout fade | ALL | Not independently tested | `HYPOTHESIS` | Not eligible |
| Volatility expansion / momentum | ALL | Not independently tested | `HYPOTHESIS` | Not eligible |
| BTC-led confirmation / relative strength | ALL | Not independently tested | `HYPOTHESIS` | Not eligible |
| Funding/OI filters | ALL | Not independently tested | `HYPOTHESIS` | Not eligible |

All historical metrics are carried forward from the prior registry and were **not recomputed**. There are **zero OOS_VALIDATED entries**.

## 4. Key discoveries

- No new strategy edge was tested.
- SOLUSDT/BULL_LOW Donchian20 remains OOS_PROMISING only; 12 trades are insufficient for the predeclared ≥100 per-symbol/context provisional gate.
- No context has been shown intrinsically untradeable. Evidence is insufficient to establish either a robust edge or a reliable no-edge region.
- The new 232-row delta improves the preserved recent raw record but does not repair the multi-year archive defects or establish an edge.

## 5. Current context snapshot

**Feature calculation:** 2026-11-13 02:20:45–02:21:02Z.  
**Mark/24h ticker:** approximately 02:19:25–02:19:30Z.  
**Top-of-book:** approximately 02:21:19Z.  
**Report cutoff:** 02:28:03Z.

| Symbol | Role | Mark / last | 24h change | 5m / 15m / 1h / 4h trend | ATR14/close 1h / 4h | 5m volume vs median20 | 15m taker buy/sell |
|---|---|---:|---:|---|---:|---:|---:|
| BTCUSDT | Reference | 70,471.96 / 70,459.50 | −4.695% | Bear / Bear / Bear / Bear | 0.665% / 1.281% | 3.07× | 0.541 |
| ETHUSDT | Tradable | 1,996.43 / 1,996.62 | −3.140% | Bear / Bear / Bear / Bear | 0.817% / 1.700% | 4.54× | 0.658 |
| SOLUSDT | Tradable | 80.63 / 80.61 | −3.692% | Bear / Bear / Bear / Bear | 0.914% / 1.926% | 3.63× | 0.737 |
| XRPUSDT | Tradable | 1.0231 / 1.0230 | −2.950% | Bear / Bear / Bear / Bear | 1.000% / 2.101% | 2.80× | 0.611 |

All 4h and 1h EMA20 values are below EMA50 with negative 10-bar EMA20 slopes. ETH and XRP have positive 10-bar 1h price returns despite bearish EMA alignment; treat this as possible countertrend rebound/transition risk, not reversal confirmation. 5m/15m volume is elevated in several symbols, but no training-derived shock threshold exists, so no calibrated shock label is assigned.

**Derivatives:** premiumIndex `lastFundingRate` fields are BTC 0.008651%, ETH 0.008730%, SOL 0.0100%, XRP 0.0100%. Latest settled rates at 00:00Z are BTC 0.0100%, ETH 0.009474%, SOL 0.0100%, XRP 0.0100%; observed interval 8h, next funding 08:00Z. No observed rate exceeds 0.05%. 24h contract OI changes are BTC +3.392%, ETH +1.840%, SOL +0.899%, XRP +0.208%; corresponding notional OI changes are −0.503%, −0.133%, −1.344%, −1.427%. This is not liquidation/crowding evidence. Latest 15m taker flow is sell-dominant for all four symbols (buy/sell ratios 0.541–0.737).

Point-in-time top-of-book spreads: BTC 0.014 bp, ETH 0.050 bp, SOL 1.236 bp, XRP 0.976 bp. These are not full execution-cost estimates.

## 6. SOL/ETH/XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Validated trigger | Decision |
|---|---|---|---|
| SOLUSDT | None | No validated registry entry | **NO_TRADE** |
| ETHUSDT | None | No validated registry entry | **NO_TRADE** |
| XRPUSDT | None | No validated registry entry | **NO_TRADE** |

No entry, stop, target or sizing is supplied. Reasons: zero OOS_VALIDATED entries; contract metadata is stale; no calibrated account fee tier, slippage/impact/fill model; no validated trigger. BTC remains reference-only.

## 7. Preflight, data-quality audit, costs and next work

| Capability/check | Status | Evidence observed | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 3 CPUs; ~4.7 GiB available RAM; ~30 GiB free disk | Local inspection/artifact generation possible |
| Repo/code | BLOCKED | No local project checkout; remote branch head `05b7dfe...`; package requires Node ≥24/npm ≥11; only Node 22.16.0 installed | Provision compatible runtime and clone exact branch |
| Binance SDK | BLOCKED | `@nemesis-oss/binance-sdk`, `binance`, `@binance/connector`, `binance-api-node` not importable | SDK not used; connector wrappers only |
| Network / Binance endpoints | DEGRADED | Six direct `fapi.binance.com` probes: HTTP 000, curl exit 6 DNS failure. Connector data succeeded; wrapper hides HTTP status/headers. exchangeInfo serverTime 01:01:01.661Z, 5,222s stale | Restore DNS/HTTPS; require fresh /time and /exchangeInfo before execution validation |
| Raw historical archive | DEGRADED | GitHub branch readable; raw sample pages fetched. 5m/15m partial; 1h gaps/count discrepancy; 4h raw/aligned/canonical mismatch and 13 SHA mismatches. New 232-row delta readback/SHA verified, indexes not advanced | Reconcile archive indexes/provenance before canonical highwater update |
| Data quality / coverage | DEGRADED | Current 16×200 windows: 3,200 rows, 3,184 completed, 16 forming excluded; zero current-window integrity failures. Multi-cycle coverage remains inadequate/inconsistent | Backfill common multi-year 5m/15m; repair 1h/4h |
| Backtest harness / smoke | BLOCKED | Remote harness exists but no local compatible runtime; 5m absent, closeTime dropped, zero volume accepted, minN=30/90% CI, no embargo CLI; smoke test NOT RUN | Fix contract and tests, then deterministic fixture twice |
| Disk / storage | PASS | `/mnt/data` writable; ~30 GiB free | Local snapshots possible |
| Artifact readback | PASS for raw delta/manifest | GitHub delta: 232 lines, 67,811 bytes, SHA-256 verified; manifest 12,703 bytes, SHA-256 verified | v106 registry/queue/snapshot/report will be readback-verified; canonical index still not updated |

### Costs and unavailable inputs

- No account fee tier, synchronized historical depth/trades, market impact, slippage, latency or fill model.
- Only eight recent settled funding records per symbol; full holding-period funding cashflows unavailable.
- No liquidation feed or historical order-book depth archive; no liquidation/crowding inference.
- No calibrated BTC-alt rolling correlation, lead/lag or relative-strength analysis.
- Direct Binance REST is DNS-blocked; connector wrappers do not expose HTTP status/headers. exchangeInfo metadata is stale and cannot validate execution status.

### Next executable order

1. RQ-002: restore direct DNS/HTTPS and retrieve fresh server time/exchange metadata.
2. RQ-005: provision Node ≥24/npm ≥11; clone and pin the exact research branch/commit.
3. RQ-003/RQ-019: reconcile 1h gaps and 4h provenance/counts; integrate the preserved 232-row delta only after index validation; backfill common multi-year 5m/15m history.
4. RQ-012/RQ-029: preserve closeTime, reject volume≤0, add 5m, add purge/embargo fixtures and remove BTC from tradable defaults.
5. RQ-004/RQ-014: calibrate execution costs and full funding cashflows.
6. RQ-021: only then freeze one strategy×context×symbol experiment with chronological train/validation/untouched OOS, block bootstrap and multiple-testing correction.
7. RQ-028: perform the overdue taxonomy stability review after the archive and runner are repaired.

**Final classification: RESEARCH_BLOCKED.** Monitoring ran and a 232-row raw delta was persisted/readback verified. No strategy experiment, no OOS evaluation, no OOS_VALIDATED entry and no trade. Canonical archive indexes/highwaters were intentionally left unchanged.
