# NEMESIS G4 — Candidate strategy specifications (pre-registered)

Status: **SPECIFIED, NOT TESTED.** No number in this file is a backtest result. Every parameter, variant and
acceptance threshold below is fixed *before* G5 runs; G5 may not change them after seeing results. A change means a
new, separately counted variant with its reason recorded.

Baseline: commit `7fd87b7` + uncommitted G0–G4 work. Data: `data/cache/vision` (see `scripts/archive-backfill.ts`).

## 1. Evidence carried in from G3

From `research-runs/regime-eval-2026-11-11T0847Z.json` (1h bars, 24h horizon, SOL/ETH/XRP, 2023-01 → 2026-11, 4,107
non-overlapping windows):

- **Volatility clusters.** HIGH_VOL_EXPANSION predicts high realized vol over the next 24h with lift 1.88, 1.6–2.1 in every year.
- **ADX says nothing about the next 24h path.** Forward efficiency ≈ 0.21 for every predicted label; 24h trend
  continuation after an ADX ≥ 25 label: 48.9% (n=1,447).
- **STRESS_CRASH** lift 4.3 but n=72 and 1.3–7.5 across years: usable as an exposure brake, not as a signal.

Consequences for every strategy here:
1. Direction must come from the strategy's own edge, never from the ADX trend label.
2. Volatility state is used for **sizing and gating**: HIGH_VOL → size × 0.5; STRESS_CRASH → no new entries, existing
   positions keep their stops. Fixed now, not tuned.

## 2. Data facts (observed, not strategy results)

- 1m klines and 1m mark-price klines, 2023-01-01 → 2026-11-09, SOL/ETH/XRP/BTC. Mark price has a real 2-minute gap on
  2024-08-12 (all symbols); a trade open across it is flagged, not interpolated.
- Funding: 4,200 settlements per symbol (8h), complete through 2026-10. Settled rate, bps, 2023-01 → 2026-10:

  | Symbol | p01 | p50 | p99 | min | max |
  |---|---|---|---|---|---|
  | SOLUSDT | −3.99 | 0.52 | 5.53 | −92.7 | 11.9 |
  | ETHUSDT | −0.95 | 0.61 | 4.52 | −3.7 | 10.2 |
  | XRPUSDT | −1.96 | 0.80 | 5.69 | −5.1 | 11.0 |
  | BTCUSDT | −0.76 | 0.61 | 4.36 | −1.5 | 8.8 |

- Positioning metrics (5m OI, top-trader account/position ratio, all-account ratio, taker buy/sell ratio): 99.9% of
  5m slots present from 2023-01-01 for all four symbols (`src/backtesting/archiveDerivatives.ts`).
- **Point-in-time rule:** a metrics snapshot stamped `t` is usable from `t + 5m`; a funding rate is usable from its
  settlement time. Signals evaluate on closed 1h bars only.

## 3. Shared execution and cost model (G5 must implement exactly this)

- Signal on a **closed 1h bar**; entry at the next 1m bar's open + slippage. Never at the signal bar's close.
- Stops, targets, trails and time exits resolved on the **1m path**. Stop and target touched in the same 1m bar → the
  stop fills (worst case). Stop fills at the stop price + slippage (gaps fill at the bar open if worse).
- Costs per side: taker 4 bps (`TAKER_FEE_RATE`) + slippage 2 bps (`SLIPPAGE_BUFFER_RATE`) = **12 bps round trip**.
  Stress runs at 1.5× and 2×.
- Funding: actual historical settlements applied to open positions at each settlement time (longs pay positive funding).
- Liquidation: checked against the **1m mark-price** path with Binance leverage brackets. Note:
  `PerpetualExecutionEngine.checkLiquidation` currently tests last-price wicks; G5 feeds it mark-price bars.
- Sizing: fixed fractional risk from `RISK_PER_TRADE_PCT` with quantity = risk / (stop distance + per-unit costs), then
  the regime multiplier from §1. One position per symbol per strategy. No pyramiding.
- Cost in R for a trade = 0.0012 / (stop distance as a fraction of price); reported per trade.

## 4. Validation protocol (fixed)

- **Development:** 2023-01-01 → 2024-12-31. Rolling walk-forward: 6-month train, 3-month test, step 3 months.
  Parameter choice inside each train window uses only the variants listed below.
- **Untouched out-of-sample:** 2025-01-01 → 2026-10-31. Evaluated **once**, only for strategies that pass development.
  Disclosure: the G3 regime evaluation already looked at volatility behaviour across 2025–2026, so the §1 sizing rule
  is not fully blind to this window. No strategy return has been computed on it.
- **Variant budget:** 27 strategy variants in total (below), plus benchmarks. Deflated Sharpe uses N = 27.
- **Benchmarks:** flat cash; unlevered buy-and-hold per symbol; simple 24h momentum (sign of last 24h, hold 24h);
  `StratifiedBaseline` random entries matched by symbol, side, regime, stop and holding time.
- **Acceptance (all required, on walk-forward test folds pooled, then confirmed on untouched OOS):**
  1. ≥ 100 trades.
  2. Mean net R > 0 and one-sided 90% bootstrap lower bound > 0 (z = 1.2816, the `liveReadiness` bar).
  3. Mean net R > 0 on at least 2 of 3 symbols.
  4. Mean net R > 0 at 1.5× costs.
  5. Both ±1-step parameter neighbours also have mean net R > 0.
  6. Beats the matched `StratifiedBaseline` and the momentum benchmark on mean net R.
  7. Deflated Sharpe probability > 0.95 with N = 27.
- Any failure → REJECTED with the failing criterion recorded. No rescue variants inside G5.

## 5. Strategies

Order is by priority, from §1 evidence and data now available.

### B1 — Volatility-compression breakout (priority 1)

1. **Edge:** After unusually quiet 24h volatility, a close outside the recent range starts a directional expansion
   larger than costs.
2. **Why it may exist:** volatility clusters (G3); stops and breakout orders resting beyond quiet ranges fire together.
3. **Other side:** range sellers and short-gamma liquidity providers whose stops sit just beyond the range.
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT.
5. **Regimes:** any except STRESS_CRASH. The compression gate below replaces regime labels.
6. **Long/short:** long on a close above the N-bar high; short on a close below the N-bar low. Both directions.
7. **Entry:** 1h close beyond the Donchian(N) channel of the *previous* N bars, while the 24h RV percentile at the
   signal bar is ≤ P. Entry next 1m open.
8. **Invalidation:** 1h close back inside the channel midpoint.
9. **Stop:** 1.5 × ATR(14, 1h) from entry, at least `MIN_STOP_ATR`.
10. **Target:** none fixed.
11. **Trail:** chandelier, 2 × ATR(14, 1h) from the highest high (long) / lowest low (short) since entry, updated on 1h closes.
12. **Max hold:** 48h.
13. **Frequency:** unknown; measured in G5.
14. **Expected costs:** 12 bps round trip ≈ 0.08R at a 1% stop.
15. **Stop trading when:** live mean net R over the last 50 trades < 0 with lower bound < −0.1R, or 1.5× realized cost vs model.
- **Variants (9):** N ∈ {24, 48, 96} × P ∈ {0.2, 0.3, 0.4}.
- **Existing code to reuse:** `DonchianBreakoutAgent`, `SqueezeBreakoutAgent` (definitions to be aligned to this spec, not vice versa).

### E1 — Funding-extreme fade (priority 2)

1. **Edge:** When funding reaches an extreme for that symbol, leveraged positioning is crowded and the next 48h drifts
   against the crowd, and the fade also *receives* funding.
2. **Why:** crowded leveraged longs (shorts) pay to hold, are forced out on adverse moves; the funding payment is a
   direct carry in our favour.
3. **Other side:** leveraged trend chasers paying the funding.
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT.
5. **Regimes:** any except STRESS_CRASH.
6. **Long/short:** short when funding ≥ the trailing-90-day pQ of that symbol; long when funding ≤ the trailing p(100−Q).
7. **Entry:** at the first 1h close after the settlement that crossed the threshold; optional filter: OI (from metrics)
   up over the prior 24h. Entry next 1m open.
8. **Invalidation:** funding settles back inside the trailing p25–p75 band → exit at next 1h close.
9. **Stop:** 2 × ATR(14, 1h).
10. **Target:** none fixed.
11. **Trail:** none (time and invalidation exits).
12. **Max hold:** 48h.
13. **Frequency:** at most a few per symbol per month by construction (tail thresholds); measured in G5.
14. **Expected costs:** 12 bps round trip; funding income/expense reported separately.
15. **Stop trading when:** the same rule as B1, or funding regime change (8h → 4h/1h interval) for that symbol.
- **Variants (6):** Q ∈ {90, 95, 97.5} × OI filter ∈ {off, on}.
- **Existing code to reuse:** `FundingArbAgent` is a delta-neutral carry design, refused by the risk gate; E1 is directional and does not reuse it.

### E2 — Crowding fade after liquidity sweep (priority 3)

1. **Edge:** an over-crowded side that has just swept a liquidity pool is exhausted; the fade toward untaken
   liquidity pays its stop.
2. **Why:** stop runs exhaust marginal crowd participants; previously untestable because positioning history was
   missing (research log: "CROWDING cannot be backtested").
3. **Other side:** late crowd entries and stopped-out counter-traders.
4–12. **As defined by `CrowdingAgent`** (stop behind the sweep, ≥ 1.2 ATR; target = nearest untaken liquidity pool
   paying `CROWDING_MIN_REWARD_RISK`; no trade without one). Crowding is measured from archive metrics
   (top-trader position ratio, all-account ratio) with the point-in-time rule from §2.
13. **Frequency:** measured in G5.
14. **Expected costs:** 12 bps round trip.
15. **Stop trading when:** same rule as B1.
- **Variants (3):** agent defaults, `CROWDING_MIN_REWARD_RISK` ∈ {1.2, 2.0}.

### C1 — Quiet-range mean reversion (priority 4)

1. **Edge:** in low-volatility conditions, 1h closes stretched far from a rolling mean revert within 24h by more than costs.
2. **Why:** liquidity provision dominates when volatility is low; there is no information shock to sustain the stretch.
3. **Other side:** late momentum entries chasing small moves.
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT.
5. **Regimes:** 24h RV percentile < 0.5 and not HIGH_VOL/STRESS. ADX is not used (G3: no information).
6. **Long/short:** long below mean − kσ; short above mean + kσ.
7. **Entry:** 1h close beyond the Bollinger(L, k) band; next 1m open.
8. **Invalidation:** RV percentile rises to ≥ 0.8 while in the trade → exit at next 1h close.
9. **Stop:** 1.5 × ATR(14, 1h) beyond entry.
10. **Target:** rolling mean (Bollinger middle) at signal time.
11. **Trail:** none.
12. **Max hold:** 24h.
13. **Frequency:** measured in G5.
14. **Expected costs:** 12 bps round trip; most sensitive of the four to costs (small targets).
15. **Stop trading when:** same rule as B1.
- **Variants (9):** k ∈ {2, 2.5, 3} × L ∈ {24, 48, 96}.
- **Existing code to reuse:** `MeanReversionAgent` (research log: proposed 779 times live, never passed the risk model; this spec re-tests it on history first).

### Deferred

- **A — trend following:** G3 found no 24h continuation after ADX trend labels. Kept only as the momentum benchmark.
  Re-open only with a different horizon or definition as a new, counted hypothesis.
- **D — SMC/ICT:** existing `src/strategies/smc-ml` and `StructureLiquidityStrategy` stay as they are; specification
  after B1/E1/E2/C1 report, so the variant budget is not spent on the most subjective family first.
- **F — multi-timeframe confluence:** only tested once at least one component passes alone.

## 6. G5 deliverables

1. One event-driven backtest runner over the mirror implementing §3 (reusing `PerpetualExecutionEngine`,
   `StratifiedBaseline`, `DeflatedSharpe`, `MonteCarlo`; no new engine).
2. Per-strategy, per-variant, per-fold, per-symbol results with gross vs net, funding, costs, max losing streak, and the
   acceptance checklist pass/fail, written to `research-runs/` with commit and config.
3. Strategy comparison table (prompt §5) with REJECTED / PASSED_DEV / PASSED_OOS verdicts.

## 7. G5 result (development window, 2023-01 → 2024-12)

Run: `npx tsx scripts/g5-backtest.ts` → `research-runs/g5-dev-2026-11-11T0902Z.json` (commit `7fd87b7` + uncommitted
G0–G5 work). Walk-forward test folds 2023-07 → 2024-12, six 3-month folds, variant chosen per fold on its 6-month train.

| Strategy | Edge | Instruments | Dir | Regime gate | TF | Trades | Gross R | Net R | 90% LCB | 1.5× cost | DSR | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 compression breakout | expansion after quiet | SOL/ETH/XRP | L/S | not STRESS | 1h/1m | 186 | −0.067 | −0.173 | −0.287 | −0.224 | 0.002 | **REJECTED** |
| C1 quiet-range reversion | stretch reverts | SOL/ETH/XRP | L/S | RV pct < 0.5 | 1h/1m | 343 | −0.095 | −0.202 | −0.309 | −0.257 | 0.000 | **REJECTED** |
| E1 funding-extreme fade | crowd pays, then unwinds | SOL/ETH/XRP | L/S | not STRESS | 1h/1m | 666 | −0.049 | −0.113 | −0.178 | −0.146 | 0.001 | **REJECTED** |
| E2 crowding fade | sweep exhaustion | — | — | — | — | — | — | — | — | — | — | **NOT TESTED** |

- Every strategy is negative **before** costs, on every symbol, and fails 6 of 7 checks; only the trade-count check passes.
- B1 and C1 also lose to the matched random-entry baseline (−0.098R, −0.170R); E1 beats random (−0.144R) but not the
  24h momentum benchmark (−0.062R), and is itself negative.
- E2 was not run: `CrowdingAgent` needs a historical `MarketState` (crowding, sweeps, liquidity pools) that no replay
  builds yet. It stays in the variant count (N = 27), which makes the deflated Sharpe stricter, not looser.
- Per §4, no strategy reached PASSED_DEV, so the untouched 2025-01 → 2026-10 window was **not** read and stays sealed.
