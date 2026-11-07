# Context Strategy Research - v78

As of: 2026-11-07 13:37:49 UTC
Classification: **RESEARCH_BLOCKED**
Research branch: research/context-strategy-2026-11-07-run23
Raw archive branch: research/raw-ohlcv-archive-2026-11-05T0530Z

## 1. Research progress

- Appended and verified **80 completed OHLCV rows** across BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT: 5m=56, 15m=20, 1h=4, 4h=0.
- Three delta/manifest pairs, SHA-256 sidecars and archive-index updates were committed and read back.
- Latest completed-open high-waters: 5m 13:30Z; 15m 13:15Z; 1h 12:00Z; 4h 08:00Z.
- No strategy experiment or untouched OOS evaluation ran. The daily experiment remains blocked.

Historical coverage:
- 1h base: 53,871 rows per symbol (215,484 total), 2020-09-14 08:00Z through 2026-11-06 22:00Z; incremental high-water 2026-11-07 12:00Z.
- 4h canonical: 13,461 rows per symbol (53,844 total), through 2026-11-05 16:00Z. Incremental high-water is 2026-11-07 08:00Z but is not merged into canonical files.
- Multi-year 5m/15m history remains absent. One 76-row delta artifact remains unresolved; 14 page-symbol hash provenance mismatches remain, although the 21,000-row alternate replay had zero row-level mismatches.

## 2. Context discovery

No training-only threshold refit was performed. Context frequency, duration, transition probabilities and classification stability were not recomputed. The live labels below are descriptive, not calibrated probabilities.

Current descriptive features: EMA20/EMA50 alignment, 5-bar EMA20 slope, ATR14 rank within the latest 200 bars, volume ratio, taker-buy share and Donchian20. Donchian20 did not break on any observed symbol/timeframe. ATR ranks are local rolling-window ranks, not training-derived regime thresholds.

## 3. Strategy-context scorecard

| Strategy/context | Evidence status | Evidence / blocker |
|---|---|---|
| 4h Donchian20, SOLUSDT BULL_LOW | OOS_PROMISING | 12 OOS trades; 66.7% win; 41.7% target-before-stop; +0.606R mean; PF 2.72; max DD 1.3R; nominal block-bootstrap 95% CI [0.086, 1.199]. Below the >=100 per-symbol/context gate; cost and robustness gates incomplete. |
| Context-aligned Donchian20 v2, all 36 symbol/context cells | INSUFFICIENT_EVIDENCE | Every cell below 100 OOS trades; nominal block-bootstrap CI includes zero; Holm-adjusted p=1.0. |
| Trend/pullback continuation | HYPOTHESIS | Not tested. |
| Breakout/retest and volatility contraction | HYPOTHESIS | Not tested. |
| Range mean reversion / failed-breakout fade | HYPOTHESIS | Not tested. |
| Volatility expansion / momentum | HYPOTHESIS | Not tested. |
| BTC-led confirmation / relative strength | HYPOTHESIS | No new lead/lag validation. |
| Funding/OI filters | HYPOTHESIS | Historical funding and positioning archive incomplete. |

OOS_VALIDATED entries: **0**. REJECTED entries: **0**. No evidence status was promoted or downgraded this run.

## 4. Key discoveries

No new strategy edge was discovered. The inherited SOLUSDT BULL_LOW Donchian candidate remains research-only and does not match the current bearish multi-timeframe context. Current market structure is not historical strategy evidence.

## 5. Current context snapshot

Snapshot time: 2026-11-07 13:37:49 UTC.

| Symbol | 5m | 15m | 1h | 4h | 24h change | OI change (45m) | 5m taker buy/sell |
|---|---|---|---|---|---:|---:|---:|
| BTCUSDT (reference) | Bear | Bear | Bear | Bear | +0.208% | -0.022% | 1.229 |
| ETHUSDT | Bear | Mixed | Mixed | Bear | +0.458% | -0.049% | 0.635 |
| SOLUSDT | Bear | Bear | Bear | Bear | -0.432% | +0.075% | 0.761 |
| XRPUSDT | Bear | Bear | Bear | Bear | -1.605% | +0.143% | 1.258 |

Premium-index latest funding-rate fields: BTC -0.000021%, ETH +0.006855%, SOL +0.000943%, XRP +0.010000%. Latest settled funding history is separately timestamped at 08:00Z: BTC +0.001332%, ETH +0.004541%, SOL +0.005614%, XRP +0.007693%. Funding interval is 8h; next funding is 16:00Z. No observed absolute rate exceeds 0.05%. Binance documents premiumIndex.lastFundingRate as the latest funding-rate field; no separate predicted-funding field was returned.

Transition warnings:
- BTC: short-horizon taker buying conflicts with bearish 4h structure; no breakout.
- ETH: 1h/15m are mixed while 4h remains bearish; no confirmed reversal.
- SOL: local 5m ATR rank is 81.2 and spread is about 1.11 bps; no breakout.
- XRP: 5m taker buying and rising OI conflict with bearish multi-timeframe structure; local 4h ATR rank is 83.9.

Confidence labels are uncalibrated feature descriptions, not win probabilities. BTC correlation/lead-lag was not recomputed this run. Liquidation data was unavailable and no liquidation inference is made.

## 6. SOL/ETH/XRP decision matrix

| Symbol | OOS_VALIDATED strategy | Trigger | Decision | Reason |
|---|---|---|---|---|
| SOLUSDT | None | No Donchian20 break | **NO_TRADE** | No validated registry entry; inherited SOL BULL_LOW candidate is research-only and context-mismatched. |
| ETHUSDT | None | No Donchian20 break | **NO_TRADE** | No validated registry entry; lower-timeframe mixed state is not an entry trigger. |
| XRPUSDT | None | No Donchian20 break | **NO_TRADE** | No validated registry entry; short-term buying does not override bearish structure or missing evidence. |

No entry, stop, target or size is supplied.

## 7. Data audit, costs, unavailable inputs, risks and next experiments

### Preflight

| Capability/check | Status | Evidence | Impact / next action |
|---|---|---|---|
| Shell/compute | PASS | Debian 13; Python 3.13.5; Node 22.16.0; npm 10.9.2; 5 CPU; 6.09GB RAM total; 30GB free disk. | Compute exists, but runtime is below repo engine floor. |
| Repo/code | DEGRADED | Remote repository accessible; no local checkout. package.json requires Node >=24 and npm >=11. | Remote audit only; provision compatible runner. |
| Network/Binance | DEGRADED | Direct DNS/HTTPS failed; HTTP000 for direct time/exchangeInfo probes. Connector market payloads succeeded; exchangeInfo serverTime is 26h19m stale. | Snapshot is possible; contract validation and execution remain blocked. |
| Raw archive | DEGRADED | Remote 1h/4h artifacts accessible; multi-year 5m/15m absent; 76-row delta unresolved. | Complete lower-timeframe backfill and 4h merge. |
| Data quality/coverage | DEGRADED | All 16 rolling series passed; long-horizon coverage/provenance remains incomplete. | Current features usable descriptively only. |
| Backtest harness/smoke | BLOCKED | scripts/backtest.ts exists remotely; no local checkout; smoke test NOT_RUN. Candle type/mapping drop closeTime; validators allow volume==0. | Fix code and run deterministic no-lookahead fixture. |
| Disk/storage | PASS | 30GB free; GitHub raw/research branches writable. | Continue verified remote persistence. |
| Artifact readback | PASS | 80-row append, manifests, checksums and archive indexes read back successfully. | Context queue/registry/report readback is recorded in the run receipt. |

### Cost and risk limitations

- Actual account fee tier unavailable.
- Historical funding cashflows beyond the latest three settled records per symbol unavailable.
- Historical spread/depth, slippage, impact and latency series unavailable. Current top-20 depth is snapshot-only.
- No liquidation feed queried.
- Do not infer crowding or liquidations from OI, candles or long/short ratios alone.
- The inherited 15bp round-trip proxy is not a validated execution-cost model.

### Next executable work

1. Backfill multi-year 5m/15m and reconcile the 76-row artifact; merge verifiable 4h increments into canonical files.
2. Restore direct Binance DNS/HTTPS or obtain fresh uncached server time and exchange metadata.
3. Provision Node24+/npm11+ checkout; preserve closeTime end-to-end and reject volume <= 0.
4. Build actual fee/funding/spread/slippage/impact assumptions.
5. Run deterministic fixture smoke tests, then freeze one strategy x context x symbol experiment with chronological train/validation/untouched-test, purging/embargo, block bootstrap and Holm correction.

**Run classification: RESEARCH_BLOCKED.** Archive maintenance and current context classification completed; no strategy experiment and no OOS evaluation completed.
