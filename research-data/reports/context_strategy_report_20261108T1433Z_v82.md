# Context Strategy Research — 8 November 2026 (v82)

**Run classification: `RESEARCH_BLOCKED`.** Monitoring and archive maintenance completed; no experiment or untouched OOS evaluation ran.

## 1. Research progress

- Retrieved Binance USDⓈ-M data for BTCUSDT, ETHUSDT, SOLUSDT and XRPUSDT across 5m/15m/1h/4h; 4h and 1h features use completed candles only.
- Appended **68 completed bars** to the raw incremental archive: 5m 48, 15m 16, 1h 4, 4h 0. The 4h 12:00 candle was still forming at the observed 14:33:10Z mark timestamp; latest completed 4h remains 08:00Z.
- Delta SHA-256: `1f38983f5ed43a60d81e47cb187e604b8e79f50ddd7818aad823d6cc36be0ed0`; 26,614 bytes. Manifest SHA-256: `e7d2021383e4bf987c7b9f1fd76c9ee5f9af5171a742277e40e5f6958ca2b87a`.
- Delta and manifest readback matched; 1h index updated and 5m/15m incremental-only indexes created and read back. Archive branch head before research snapshots: `07e15cb0f8c8244e455df86cac61b52914aa0e04`.
- Full rolling audit: 16 series, 4,000 raw bars, 3,984 completed and 16 forming excluded. Zero duplicates, gaps, off-grid timestamps, OHLC failures, non-positive volume, non-finite values or non-monotonic rows; all four symbols aligned per interval.
- No backtest, smoke test, experiment or OOS run completed.

### Archive coverage

| Interval | Existing base coverage | This run | Assessment |
|---|---|---:|---|
| 1h | 215,484 base rows; 53,871/symbol; base through 2026-11-06 22:00Z | +4 | Multi-year base exists; incremental highwater 13:00Z |
| 4h | 53,952 raw; 53,816 aligned; ~6.14 years | +0 | Latest incremental completed open remains 08:00Z; canonical reconciliation still incomplete |
| 5m | No multi-year base | +48 | Incremental only |
| 15m | No multi-year base | +16 | Incremental only |

The 4h archive retains 13 expected-vs-actual manifest hash mismatches and raw-vs-canonical row-count discrepancies. The 4h canonical base/index is not fully rebuilt through the latest incremental delta. The 5m/15m indexes created here track the v82 delta only; older delta history is not yet fully consolidated into those dedicated indexes.

## 2. Context discovery

Frozen v56 taxonomy; no refit. Trend strength is `(EMA20−EMA50)/Wilder ATR14`; `TRANSITION` if absolute strength is below the symbol's frozen training q67, otherwise sign selects BULL/BEAR. Volatility is Wilder ATR14/close split at frozen per-symbol q33/q67. Classification confidence and shock probability are not calibrated.

| Symbol | 4h test rows | BEAR_LOW | TRANSITION_LOW | BULL_LOW | Validation/test TVD | Median transition duration |
|---|---:|---:|---:|---:|---:|---:|
| BTC | 2,345 | 6.53% | 50.66% | 9.85% | 0.175 | 38h |
| ETH | 2,273 | 6.42% | 46.24% | 6.64% | 0.338 | 42h |
| SOL | 2,010 | 10.90% | 67.56% | 10.70% | 0.245 | 120h |
| XRP | 2,237 | 15.20% | 43.63% | 3.22% | 0.293 | 68h |

These historical statistics are carried forward from the accessible v81/v56 artifacts, not recomputed today. Adequate for descriptive 4h context review; insufficient for strategy-edge or multi-timeframe generalization. ETH/XRP show material validation/test drift. Weekly review is due 11 November UTC.

## 3. Strategy-context scorecard

| Strategy/context | Status | Evidence | Current applicability |
|---|---|---|---|
| 4h Donchian20, SOL/BULL_LOW | `OOS_PROMISING` | 12 OOS trades; 66.7% win; 41.7% target-before-stop; +0.606R mean net; PF 2.72; max DD 1.3R; block-bootstrap CI95 [0.086, 1.199] | Not applicable: current SOL is BEAR_LOW; 12 trades are below the 100/cell gate |
| Context-aligned Donchian20 WF v2, 36 cells | `INSUFFICIENT_EVIDENCE` | All cells <100 OOS trades; block-bootstrap CI includes zero; Holm-adjusted p=1.0 | No actionable cell |
| Trend/pullback, breakout/retest, range MR/failed-breakout, volatility expansion, BTC-relative strength, funding/OI filters | `HYPOTHESIS` | No valid new experiment | Research only |

`OOS_VALIDATED=0`; `REJECTED=0`. Aggregate Donchian20 mean net R remains BTC −0.1008, ETH +0.0478, SOL −0.0177, XRP +0.0489; these aggregate results are not conditional proof.

## 4. Key discoveries

- No new edge was discovered or rejected.
- The only inherited promising cell remains SOL/BULL_LOW and is not applicable to current SOL/BEAR_LOW.
- No context has been proven intrinsically untradeable; absence of validated evidence is not proof of no edge.
- Current 1h alignment shifted to `BEAR_ALIGNED` for ETH and SOL; XRP remains `BEAR_ALIGNED`; BTC remains `MIXED`. 4h labels are unchanged from v81.

## 5. Current context snapshot

**Market data as of 2026-11-08 14:33:10 UTC.**

| Symbol | Role | Last | Mark | 24h change | 4h context | Trend strength ATR | ATR14/close | 1h state |
|---|---|---:|---:|---:|---|---:|---:|---|
| BTC | Reference | 75,966.70 | 75,976.98 | +0.075% | BEAR_LOW | −1.375 | 0.910% | MIXED |
| ETH | Tradable | 2,238.00 | 2,238.51 | −0.320% | TRANSITION_LOW | −0.832 | 1.197% | BEAR_ALIGNED |
| SOL | Tradable | 89.21 | 89.2347 | −0.845% | BEAR_LOW | −1.646 | 1.542% | BEAR_ALIGNED |
| XRP | Tradable | 1.1594 | 1.159971 | −0.651% | BEAR_LOW | −1.795 | 1.717% | BEAR_ALIGNED |

All 4h Donchian20 states are NONE. Latest completed 4h open is 08:00Z; 1h open 13:00Z; 15m open 14:15Z; 5m open 14:25Z.

Funding interval is 8h; next funding is 16:00Z. The live `premiumIndex.lastFundingRate` fields were BTC 0.003414%, ETH 0.004863%, SOL 0.009020%, XRP 0.006951%; the last settled history records at 08:00Z were BTC 0.007157%, ETH 0.010000%, SOL 0.005796%, XRP 0.010000%. They are reported separately; do not assume the live premiumIndex field is the final next settlement. None exceeds the 0.05% absolute threshold.

24h OI change from the 14:00Z-to-14:00Z hourly history window: BTC −0.455%, ETH +0.361%, SOL +0.035%, XRP −0.403%. Global account long/short ratios at 14:00Z: BTC 3.058, ETH 3.515, SOL 3.649, XRP 2.860. These are positioning descriptors, not proof of crowding or liquidation risk.

Top-of-book spreads: BTC 0.013 bps, ETH 0.045 bps, SOL 1.121 bps, XRP 0.862 bps. Top-20 depth imbalance: BTC +0.140, ETH −0.345, SOL −0.069, XRP −0.034. Snapshots only; not execution-cost estimates.

## 6. Trade decisions

| Symbol | Validated strategy | Trigger | Decision |
|---|---|---|---|
| SOL | None | No validated rule; no Donchian20 breakout | **NO_TRADE** |
| ETH | None | No validated rule; no Donchian20 breakout | **NO_TRADE** |
| XRP | None | No validated rule; no Donchian20 breakout | **NO_TRADE** |

## 7. Preflight, blockers and next actions

| Check | Status | Evidence / impact |
|---|---|---|
| Shell/compute | PASS | Debian 13, Python 3.13.5, 5 CPUs, 4.93 GB available RAM, 30 GB free disk |
| Repo/runtime/SDK | DEGRADED | No local checkout; Node 22.16/npm 10.9 below package requirement Node >=24/npm >=11; SDK not installed |
| Binance network | DEGRADED | Connector works; direct REST endpoints failed DNS/timeout with HTTP 000; exchangeInfo serverTime stale 51.24h |
| Raw archive | DEGRADED | 1h/4h multi-year bases; 5m/15m base absent; 13 4h hash mismatches; canonical 4h lags incremental |
| Rolling data quality | PASS | 3,984 completed bars; all structural counters zero |
| Backtest/smoke test | BLOCKED | Remote harness exists but no compatible local runner; no smoke test |
| Disk/storage | PASS | 30 GB free; GitHub writes available |
| Artifact readback | PASS | Delta, manifest and indexes read back; delta SHA matched |

Direct REST probes attempted: `/fapi/v1/time`, `/fapi/v1/exchangeInfo`, `/fapi/v1/klines`, `/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, `/fapi/v1/ticker/24hr`; all direct shell calls returned HTTP 000 due DNS failure/timeout. Connector calls succeeded for market data but did not expose raw HTTP status.

**Exact blocker for zero experiments:** the compatible Node 24/npm 11 runner and local checkout are absent; the direct REST network route is unavailable; multi-year 5m/15m and full historical funding/cost inputs are incomplete; EXP-001 also includes BTCUSDT in its trade-symbol list although BTC must be reference-only. No harness smoke test ran.

Next: provision Node 24/npm 11 and checkout; fix Candle.closeTime, 5m support and volume<=0 validation; separate BTC reference symbols; reconcile canonical 4h hashes/rows; backfill multi-year 5m/15m and funding history; calibrate fees/spread/slippage; then smoke-test and freeze EXP-001.

**Result: `RESEARCH_BLOCKED`.** Archive append and registry/queue/report persistence completed; no experiment or untouched OOS evaluation completed.
