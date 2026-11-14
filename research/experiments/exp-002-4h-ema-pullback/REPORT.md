# Context Strategy Research — 2026-11-09 01:14 UTC

## Run classification
**RESEARCH_EXECUTED + OOS_EVALUATED.** One reproducible experiment completed and its untouched chronological test was evaluated. **No OOS_VALIDATED strategy exists.** The repository Node CLI was not invoked; the standalone core ran in managed V8 and passed deterministic fixture checks.

## 1. Research progress
- Appended **112 completed OHLCV rows**: 104 across 5m/15m/1h/4h, then 8 additional 5m rows.
- Raw highwaters: 5m 01:05Z, 15m 00:45Z, 1h 00:00Z, 4h 20:00Z.
- Independently read and audited all four canonical 4h files: 13,461 rows per symbol, 2020-09-14 08:00Z through 2026-11-05 16:00Z; zero duplicates, gaps, off-grid timestamps, OHLC violations, nonpositive volume, nonfinite values or close-time errors.
- Persisted 1,004 OOS funding settlements per tradable for EXP-002.
- 5m/15m long-history backfill remains incomplete; canonical 4h remains behind raw incremental highwater.

## 2. Context discovery
Thresholds fitted on training only: trend strength = (EMA20-EMA50)/ATR14; strong trend at absolute q67; volatility = ATR14/close, LOW <= q33, NORMAL <= q67, HIGH above q67.
- SOL test: TRANSITION_LOW 67.13%, BULL_LOW 10.61%, BEAR_LOW 10.81%; median durations 130h, 36h and 64h respectively.
- ETH test: TRANSITION_LOW 47.86%, TRANSITION_NORMAL 21.66%, BULL_LOW 6.92%, BEAR_LOW 6.62%, BEAR_HIGH 5.88%.
- XRP test: TRANSITION_LOW 49.20%, BEAR_LOW 16.88%, TRANSITION_NORMAL 14.69%, BEAR_NORMAL 6.27%.
- Train/validation and validation/test context TVD: SOL 0.352/0.263; ETH 0.231/0.405; XRP 0.134/0.360. Drift is material.

## 3. Strategy-context scorecard
EXP-002: 4h EMA20/EMA50 pullback continuation. Strong BULL/BEAR LOW/NORMAL context; completed bar touches EMA20 and closes back on trend side of EMA20 and EMA50; enter next open. Stop 1.5 ATR, target 2R, time stop 6 bars/24h, one position at a time, stop-first on same-bar ambiguity.
| Symbol | OOS trades | Win rate | Target before stop | Mean net R | PF | Max DD | Block-bootstrap 95% CI | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| SOL | 27 | 51.85% | 7.41% | +0.0098R | 1.029 | 5.77R | [-0.315, +0.421] | INSUFFICIENT_EVIDENCE |
| ETH | 23 | 52.17% | 4.35% | -0.1576R | 0.653 | 7.22R | [-0.561, +0.279] | INSUFFICIENT_EVIDENCE |
| XRP | 39 | 46.15% | 5.13% | -0.0535R | 0.850 | 10.24R | [-0.376, +0.298] | INSUFFICIENT_EVIDENCE |

Test: 2025-12-05 04:00Z to 2026-11-04 19:59:59.999Z; 2,008 4h bars/symbol after 6-bar embargo. Train 70%, validation 15%, untouched test 15%; 500-bar warmup. Funding coverage 1,004/1,004 per symbol. Bootstrap 2,000 replicates, 5-trade blocks; Holm-adjusted p=1.0 for all symbols.

Validation expectancy: SOL +0.0058R, ETH -0.3279R, XRP -0.2206R. At 25bp round-trip cost stress, SOL turns negative (-0.0212R); ETH/XRP remain negative. Targets were reached only 2/27 SOL, 1/23 ETH and 2/39 XRP trades; time stops dominated.

Buy-and-hold test returns: SOL -31.9%, ETH -24.3%, XRP -38.0%. EMA20/50 regime baseline: SOL +43.0%, ETH -16.2%, XRP -39.0%, but with large drawdowns and different exposure/risk.

**No promotion or rejection.** Every EXP-002 symbol cell remains INSUFFICIENT_EVIDENCE: fewer than 100 OOS trades and confidence intervals include zero.

## 4. Key discoveries
1. Transition contexts dominate; the strong-trend filter sharply reduces eligible observations.
2. Target-before-stop frequency is very low despite win rates near 50%; time stops dominate.
3. ETH/XRP validation is negative; SOL is near zero and cost-sensitive.
4. Context distribution drift is material; do not assume stationarity.
5. No universal edge is demonstrated. BTC remains reference-only.

## 5. Current context snapshot
As of 2026-11-09 01:14 UTC: BTC BEAR_LOW, ETH TRANSITION_LOW, SOL BEAR_LOW, XRP BEAR_NORMAL. All 1h trends are BEAR. Completed 4h ranges are 3.98x, 7.19x, 3.69x and 3.44x prior ATR respectively; all are shock candidates, not calibrated shock probabilities. 5m/15m taker flow is mixed-to-buying. OI fell over 24h in ETH/SOL/XRP; this is not proof of liquidations. Funding is below 0.05% absolute; next settlement 08:00Z.

## 6. Decisions
| Symbol | OOS_VALIDATED rule | Trigger | Decision |
|---|---|---|---|
| SOL | None | None | **NO_TRADE** |
| ETH | None | None | **NO_TRADE** |
| XRP | None | None | **NO_TRADE** |
Reason: zero OOS_VALIDATED entries, EXP-002 is insufficient, and the shock filter fails. No levels or sizing issued.

## 7. Data quality, costs, limitations and next actions
- Cost proxy: 15bp round-trip (4bp fee/side + 2bp slippage/side + 3bp round-trip spread/impact buffer); sensitivity 12/25bp. Historical spread/impact and actual fee tier are not calibrated. OOS funding included.
- Direct DNS to official Binance REST failed. Connector returned data but not HTTP status/headers. exchangeInfo serverTime was ~43m45s stale, so contract metadata is not valid for execution checks.
- Current depth20/global account long-short are snapshots; no historical depth, top-trader positioning or liquidation feed.
- 4h canonical files are verified but end Nov5 16:00Z; raw incremental extends Nov8 20:00Z. Full raw-page row-key reconciliation and canonical rebuild remain queued.
- 1h index reports 215,484 rows. 5m/15m are incremental-only; 1m is not staged.
- Repository package requires Node>=24/npm>=11; current runtime Node22.16/npm10.9 and no local checkout. Custom V8 harness passed; repository CLI remains unverified.

Next: reconcile/rebuild canonical 4h, backfill multi-year 5m/15m and 1m, provision Node24/npm11, then calibrate execution costs. Do not tune EXP-002 against its final test.