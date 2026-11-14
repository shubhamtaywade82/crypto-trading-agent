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

Run: `npx tsx scripts/g5-backtest.ts` → `research-runs/g5-dev-2026-11-11T1740Z.json` (commit `7fd87b7` + uncommitted
G0–G5 work). Walk-forward test folds 2023-07 → 2024-12, six 3-month folds, variant chosen per fold on its 6-month train.

| Strategy | Edge | Instruments | Dir | Regime gate | TF | Trades | Gross R | Net R | 90% LCB | 1.5× cost | DSR | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 compression breakout | expansion after quiet | SOL/ETH/XRP | L/S | not STRESS | 1h/1m | 186 | −0.067 | −0.173 | −0.287 | −0.224 | 0.002 | **REJECTED** |
| C1 quiet-range reversion | stretch reverts | SOL/ETH/XRP | L/S | RV pct < 0.5 | 1h/1m | 343 | −0.095 | −0.202 | −0.309 | −0.257 | 0.000 | **REJECTED** |
| E1 funding-extreme fade | crowd pays, then unwinds | SOL/ETH/XRP | L/S | not STRESS | 1h/1m | 666 | −0.049 | −0.113 | −0.178 | −0.146 | 0.001 | **REJECTED** |
| E2 crowding fade | sweep exhaustion | SOL/ETH/XRP | L/S | not STRESS | 15m/1m | 3293 | −0.017 | −0.233 | −0.275 | −0.346 | 0.000 | **REJECTED** |

- Every strategy is negative **before** costs, on every symbol, and fails 6 of 7 checks; only the trade-count check passes.
- E2 is ~flat before costs (−0.017R) but its 15m-ATR stops are tight, so 12 bps round trip costs 0.225R per trade. It
  fires 3,293 times in 18 months: the agent's crowding thresholds (e.g. top-trader position ratio ≥ 1.7) are met most of
  the time, so "crowded" is not an extreme on these symbols.
- B1 and C1 also lose to the matched random-entry baseline (−0.098R, −0.170R); E1 beats random (−0.144R) but not the
  24h momentum benchmark (−0.062R), and is itself negative.
- E2 replays the live agent's own decision (`crowdingFade`, extracted from `CrowdingAgent`) on a `MarketState` rebuilt
  at every closed 15m bar by `src/research/CrowdingReplay.ts`. Known gaps vs live: settled (not predicted) funding,
  1h taker ratio from 1m klines, 5m ratio snapshots usable at bar close, and a 48h time cap the agent does not define.
- Per §4, no strategy reached PASSED_DEV, so the untouched 2025-01 → 2026-10 window was **not** read and stays sealed.

## 8. Addendum (pre-registered 2026-11-11, before any time-of-day statistic was computed)

Same execution model (§3), folds and acceptance (§4). Variant budget rises from 27 to **33**; deflated Sharpe uses N = 33
for every strategy in the re-run. Price-only intraday rules failed in §7 with gross ≈ 0, so these test the clock and the
funding cycle instead of chart patterns.

### T1 — Hour-of-day drift

1. **Edge:** some UTC hours have a persistent mean return (session flows: Asia/EU/US opens, fixings, rebalancing).
2. **Why:** recurring, clock-driven flows that are not information-driven, so they need not be arbitraged instantly.
3. **Other side:** participants who must trade at fixed times (index/fund rebalancing, payroll-style DCA, session hedgers).
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT, each with its own statistics.
5. **Regimes:** any except STRESS_CRASH; HIGH_VOL halves size (§1).
6–7. **Entry:** at each 1h close, for the next UTC hour u: mean and t-statistic of that symbol's open→close log return of
   hour u over the trailing 180 days (point-in-time: only completed bars). If |t| ≥ τ, enter in the sign of the mean at
   the next 1m open. Consecutive upcoming hours that also pass with the same sign extend the hold, so one round trip
   covers the whole block.
8. **Invalidation:** none beyond the clock.
9. **Stop:** 3 × ATR(14, 1h), a disaster stop only.
10–11. **Target/trail:** none.
12. **Max hold:** the selected block, at most 6h.
13. **Frequency:** depends on how many hours pass; measured.
14. **Costs:** 12 bps per block. A 1h block must clear it with its own mean return, which §2 data suggests is hard.
15. **Stop trading:** as B1.
- **Variants (3):** τ ∈ {2, 2.5, 3}.

### T2 — Funding-settlement rebound

1. **Edge:** when funding is high, longs close into the settlement to avoid paying it and reopen after, so price
   rebounds after settlement (mirror for negative funding).
2. **Why:** a mechanical, scheduled flow tied to the funding clock.
3. **Other side:** traders who flatten before settlement to dodge funding and re-enter after.
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT.
5. **Regimes:** any except STRESS_CRASH; HIGH_VOL halves size.
6–7. **Entry:** at the first 1h close at or after a settlement whose settled rate is ≥ the trailing-90-day p75 → long;
   ≤ p25 → short. Next 1m open.
8. **Invalidation:** none.
9. **Stop:** 3 × ATR(14, 1h).
10–11. **Target/trail:** none.
12. **Max hold:** H hours.
13. **Frequency:** up to 3 per day per symbol, at most half the settlements by construction.
14. **Costs:** 12 bps round trip.
15. **Stop trading:** as B1.
- **Variants (3):** H ∈ {1, 2, 4}.

### §8 result (development window, N = 33)

Run `npx tsx scripts/g5-backtest.ts` → `research-runs/g5-dev-2026-11-11T1740Z.json` (B1/C1/E1/E2 numbers unchanged
except DSR now uses N = 33; all still REJECTED).

| Strategy | Trades | Gross R | Cost R | Net R | 90% LCB | 1.5× cost | Beats random/momentum | DSR | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| T1 hour-of-day drift | 1825 | **+0.040** | 0.050 | −0.011 | −0.018 | −0.036 | yes (−0.054 / −0.062) | 0.000 | **REJECTED** |
| T2 settlement rebound | 3603 | +0.002 | 0.043 | −0.041 | −0.052 | −0.063 | no (random −0.034) | 0.000 | **REJECTED** |

- T1 is the first candidate with a **positive gross** result; the interval half-width (~0.007R) puts it several standard
  errors above zero before costs. Taker costs (0.050R) erase it. XRPUSDT carries most trades (1,307 of 1,825) and is the
  only symbol at or above zero net.
- T2 shows no gross effect.
- Any cheaper-execution version of T1 is a **new** hypothesis: it must be pre-registered and counted (N = 34+), not
  re-scored from this run.

## 9. Addendum (pre-registered 2026-11-11, after §8, before any maker-entry run)

### T1M — Hour-of-day drift with passive entry

Prompted by §8: T1 was positive before costs and negative after. Same signal, holds and stops as T1. Only the entry changes:

- **Entry:** limit order at the nominal entry minute's open price. Filled only if, within the first **5 minutes**, price
  trades **strictly through** the limit (low below it for a buy, high above it for a sell), so no queue position is
  assumed. No fill → no trade. Fill price = the limit. The hold still ends at the nominal block end.
- **Costs:** entry 2 bps maker fee, no slippage; exit and stops at taker 4 bps + 2 bps slippage. Round trip 8 bps vs 12.
- **Adverse selection is in the model, not assumed away:** fills happen only when price moves against the entry first;
  missed trades are the ones that moved in our favour immediately.
- **Benchmark fairness:** the matched random baseline uses the same passive entry rule.
- **Variants (3):** τ ∈ {2, 2.5, 3}. N rises from 33 to **36**.
- **Known risk carried in:** in §8, XRPUSDT carried 1,307 of 1,825 T1 trades; check 3 (two of three symbols) is the guard.

### §9 result (N = 36)

Run `npx tsx scripts/g5-backtest.ts` → `research-runs/g5-dev-2026-11-11T1740Z.json`.

| Strategy | Trades | Gross R | Cost R | Net R | 90% LCB | 1.5× cost | Symbols > 0 | vs random / momentum | DSR | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| T1M passive-entry hour drift | 1725 | +0.036 | 0.033 | **+0.002** | −0.005 | −0.014 | XRP only (+0.015R/1228) | beats both (−0.023 / −0.062) | 0.000 | **REJECTED** |

- Passive entry cut costs from 0.050R to 0.033R per trade and filled 1,725 of the ~1,825 T1 opportunities; adverse
  selection cost about 0.004R of gross (0.040 → 0.036). Net is breakeven, not an edge.
- Fails checks 2, 3, 4 and 7; passes trade count, neighbours and both baselines.
- The effect lives almost entirely in XRPUSDT. An XRP-only follow-up would be chosen *after* seeing this split, so it
  would need its own pre-registration with that disclosure and a fresh untouched window to mean anything.

## 10. Addendum (pre-registered 2026-11-11, before any multi-day statistic was computed) — short swing

Intraday rules found no edge larger than costs (§7–§9). These move to multi-day holds, where 12 bps is small relative to
the move. Still within the mandate: short-term swing, max hold 14 days, no long-term investing. Same execution (§3),
folds and acceptance (§4); the §1 regime gate (STRESS no entry, HIGH_VOL half size) applies unchanged. Variant budget
rises from 36 to **42**.

Daily sigma = the 30-day realized 1h-return volatility × √24, at the signal bar (point-in-time, from `RegimeClassifier`).

### L1 — Weekly time-series momentum

1. **Edge:** crypto returns over the past 1–4 weeks predict the next week's sign (time-series momentum).
2. **Why:** slow information diffusion and trend-chasing flows in a retail-heavy market; documented at weekly horizons
   in crypto, unlike the 24h horizon where G3 found none.
3. **Other side:** contrarian and mean-reverting liquidity providers on weekly horizons.
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT.
6–7. **Entry:** every Monday 00:00 UTC close: side = sign of the log return over the last L days. Next 1m open.
9. **Stop:** 2 × daily sigma × √7 × price (a ~2 weekly-sigma disaster stop).
10–11. **Target/trail:** none.
12. **Max hold:** 7 days (re-decided next Monday).
13. **Frequency:** ≤ 1 per symbol per week (~100 per symbol in the dev window).
14. **Costs:** 12 bps per week.
- **Variants (3):** L ∈ {7, 14, 28}.

### L3 — Daily Donchian breakout with trail

1. **Edge:** a daily close beyond the N-day range starts a multi-day trend.
2. **Why:** stop clusters and trend-following flows at well-known daily levels; multi-day moves dwarf costs.
3. **Other side:** range traders and short-volatility sellers.
4. **Instruments:** SOLUSDT, ETHUSDT, XRPUSDT.
6–7. **Entry:** at each UTC day close (00:00), if the day's close is above the highest high (below the lowest low) of
   the N prior days → long (short). Next 1m open.
9. **Stop:** 2 × daily sigma × price.
11. **Trail:** chandelier at 3 × daily sigma × price from the best price since entry, ratcheted on 1h closes.
12. **Max hold:** 14 days.
13. **Frequency:** low; the trade-count check (≥ 100) may fail on two years of data, and that is a valid rejection.
14. **Costs:** 12 bps round trip.
- **Variants (3):** N ∈ {10, 20, 55}.

### §10 result (N = 42)

Run `npx tsx scripts/g5-backtest.ts` → `research-runs/g5-dev-2026-11-11T1740Z.json`.

| Strategy | Trades | Gross R | Cost R | Funding R | Net R | 90% LCB | 1.5× cost | Symbols > 0 | vs random / momentum | DSR | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 weekly momentum | 236 | +0.013 | 0.007 | −0.003 | +0.003 | −0.065 | −0.001 | XRP only | loses to random (+0.077) | 0.000 | **REJECTED** |
| L3 daily Donchian + trail | 71 | **+0.243** | 0.019 | −0.020 | **+0.205** | −0.015 | +0.195 | SOL, XRP | beats both (−0.015 / −0.062) | 0.000 | **REJECTED** |

- L3 is the strongest candidate so far: costs are ~0.02R, the result survives 2× costs, both parameter neighbours are
  positive, and it beats both baselines by a wide margin. It fails on **evidence size**: 71 trades (< 100), a lower
  bound just below zero, and a deflated Sharpe near zero with 42 trials. Win rate 39% with a fat right tail, the usual
  trend-following shape.
- L1 shows no weekly momentum on these symbols in 2023–2024.
- Per §4 there is no rescue inside G5. L3's rules are frozen as written; the honest next test is more independent data.

## 11. Addendum (pre-registered 2026-11-11, before any 2020–2022 data was downloaded) — L3 replication

L3 (§10) passed every check except evidence size. The cleanest test that does not touch the sealed 2025–2026 window is
an **earlier, never-seen period**, run with L3 exactly as frozen in §10 (same three variants, same stops, trail, hold,
regime gate, costs and acceptance).

- **Data:** 2020-11-01 → 2023-01-01 from the same archive (klines, mark price, funding; positioning metrics not needed).
  First two months are warm-up only.
- **Folds:** 6-month train / 3-month test, test windows 2021-07-01 → 2023-01-01 (six folds), as in §4.
- **Trial count:** N = **45** (all 42 earlier variants + these 3), not 3: the replication is chosen because of §10.
- **Decision rule:** L3 counts as PASSED_DEV only if it passes all seven checks here **and** the pooled 2021–2022 +
  2023–2024 walk-forward trades show mean net R > 0 with a positive 90% lower bound. Only then is the sealed
  2025–2026 window opened, once, for L3 alone.
- Nothing else changes. No new variants, no filter added after seeing 2020–2022.

### §11 result — L3 replication on 2021–2022 (N = 45)

Run `npx tsx scripts/g5-backtest.ts --from 2020-11-01 --to 2023-01-01 --first-test 2021-07-01 --strategies L3 --trials 45
--trial-sr-var 9.29e-3` → `research-runs/g5-dev-2026-11-11T1743Z.json` (trial Sharpe variance taken from the full §10
search, so three similar variants cannot make the deflated Sharpe lenient).

| Window | Trades | Gross R | Net R | 90% LCB | 1.5× cost | Symbols > 0 | Matched random | DSR | Checks |
|---|---|---|---|---|---|---|---|---|---|
| 2023–2024 (§10) | 71 | +0.243 | +0.205 | −0.015 | +0.195 | SOL, XRP | −0.015 | 0.000 | 5/7 |
| 2021–2022 (§11) | 61 | +0.304 | **+0.274** | **+0.060** | +0.267 | SOL, XRP | **+0.207** | 0.000 | 5/7 |

**Verdict: REJECTED under the §11 rule** (it must pass all seven checks in the replication window): it fails the trade
count (61 < 100) and the deflated Sharpe (daily SR 0.068 vs the bar set by 45 trials). The sealed 2025–2026 window stays
closed.

What the evidence does say, without overstating it:
- L3 is positive net in **both** independent periods, robust to 2× costs, with positive parameter neighbours in both.
  Pooled (132 trades) the mean is about +0.24R; a rough pooled lower bound is positive, but that is an approximation
  from the two runs' intervals, not a computed result.
- In 2021–2022 the matched random baseline was itself +0.207R: a strong bull market rewarded any long-biased entry.
  L3's margin over random there is only ~0.07R. Part of L3's result is market direction, not the breakout rule.
- ETHUSDT is negative in both periods; SOLUSDT carries most of the result (+0.742R on 19 trades in 2021–2022).
- The binding constraint is sample size: a daily breakout fires ~30 times a year across three symbols. More history on
  these symbols does not exist on Binance perps before 2020–2021.

## 12. Addendum (pre-registered 2026-11-11, before any data for these symbols was downloaded) — L3 breadth test

**Research only. Nothing here changes what NEMESIS may trade** (SOL/ETH/XRP; BTC context-only).

L3's binding constraint is sample size (§11). The same frozen L3 rules run on other liquid USDⓈ-M perpetuals add
independent trades.

- **Symbols (fixed list, 10):** BTCUSDT, BNBUSDT, ADAUSDT, DOGEUSDT, LINKUSDT, LTCUSDT, DOTUSDT, AVAXUSDT, TRXUSDT,
  BCHUSDT. Rule: large, liquid perps listed before 2020-11 that still trade under the same symbol today (MATIC excluded:
  renamed to POL in 2024). **Survivorship bias disclosure:** the list is chosen with today's knowledge of which
  contracts survived; delisted coins are missing, which flatters any long-biased rule.
- **Windows:** both non-sealed walk-forward windows, run separately: 2021-07 → 2023-01 (data from 2020-11) and
  2023-07 → 2025-01 (data from 2023-01). The 2025–2026 window stays sealed.
- **Variants:** the same three (N ∈ {10, 20, 55}), selected per fold on train exactly as §4. Trial count **N = 48**.
- **Regime gate:** each symbol's own regime, with BTCUSDT as the crash anchor (as for SOL/ETH/XRP).
- **Acceptance:** the seven §4 checks per window, with check 3 generalised to "mean net R > 0 on at least ⌈2/3⌉ of the
  symbols" (7 of 10; for three symbols this is the original 2 of 3).
- **What a pass means:** evidence that the L3 *rule* carries across liquid perps, supporting a forward paper test of L3
  on SOL/ETH/XRP. It does **not** add any symbol to the trading universe.

### §12 result — L3 breadth test (N = 48)

| Window | Trades | Gross R | Net R | 90% LCB | Symbols > 0 | Matched random | Momentum | Checks | Report |
|---|---|---|---|---|---|---|---|---|---|
| 2021–2022 | 218 | −0.014 | **−0.041** | −0.161 | 4 of 10 | +0.182 | −0.127 | 1/7 | `research-runs/g5-dev-2026-11-11T1800Z.json` |
| 2023–2024 | 261 | +0.021 | **−0.012** | −0.147 | 5 of 10 | +0.019 | −0.018 | 1/7 | `research-runs/g5-dev-2026-11-11T1801Z.json` |

**Verdict: REJECTED in both windows.** On ten other liquid perps the same frozen L3 rules are flat to negative after
costs and funding, lose to matched random entries, and are positive on only 4–5 of 10 symbols, with the sign of each
symbol flipping between windows (e.g. LTC +0.470R then −0.388R; TRX −0.217R then +0.355R).

Interpretation: L3's positive SOL/XRP results in §10–§11 do not generalise to the rule. They are consistent with
symbol-specific luck in a small sample (SOL's 2021 rally in particular), not with a breakout edge. A forward paper test of
L3 is **not** justified by this evidence. The sealed 2025–2026 window remains unopened.

## 13. Addendum (pre-registered 2026-11-14, before any cross-sectional return was computed) — weekly long/short across perps

**Research only. Nothing here changes what NEMESIS may trade** (SOL/ETH/XRP; BTC context-only). A pass would be a case for
widening the mandate, which is the user's decision, not this document's.

Why this family: every single-symbol rule in §7–§12 is flat or negative, and §11 showed that long-biased rules are
flattered by market direction (matched random +0.207R). A dollar-neutral rank portfolio removes market direction by
construction, adds breadth (30 symbols, not 3), and holds 7 days so 12 bps is small. Cross-sectional momentum, short-term
reversal, funding/positioning and low-risk effects are the documented crypto anomalies; none has been tested here.

- **Data:** daily klines and settled funding for every USDⓈ-M USDT perpetual in the archive (923 symbols, including
  delisted ones such as LUNAUSDT, so the universe is point-in-time and survivorship is removed). Excluded by name:
  BTCDOM*, DEFI*, FOOTBALL*, BLUEBIRD* (index contracts), USDC*. Mirror: `data/cache/vision/monthly/{klines/*/1d,fundingRate}`.
- **Universe at each rebalance:** ≥ 90 daily bars of history, mean daily quote volume over the prior 30 days ≥ 10 M USDT,
  then the top **K = 30** by that volume. Fewer than 15 eligible → the week is skipped.
- **Rebalance:** every Monday 00:00 UTC. Signals use daily bars closed by Sunday 24:00; trades fill at Monday's daily open
  (the first trade of the day) with the §3 costs; exit at the next Monday's open. A symbol that stops trading mid-hold
  exits at its last close. Long the top Q = **6**, short the bottom Q = 6 of the ranked universe, equal weight, one unit of
  notional per leg. Weekly return = mean(long) − mean(short) − costs ± funding, per unit of one leg's notional.
- **Costs:** 6 bps (4 taker + 2 slippage) per side on the traded notional only (|Δweight|, so a symbol kept across weeks
  does not pay again). Funding: actual settlements in (entry, exit] on each position (long pays positive, short
  receives). No leverage assumed; liquidation is not modelled (unlevered legs of 1/6 notional per symbol).
- **Signals (6 variants, directions fixed here, no mirrors):**
  - X1 momentum 14d: long highest 14-day return. X2 momentum 28d.
  - X3 reversal 7d: long lowest 7-day return.
  - X4 funding 7d: long lowest **sum** of settled funding rates over the prior 7 days (settlements in [Monday−7d, Monday 00:00); the weekly carry, comparable across 8h/4h/1h funding intervals), short highest.
  - X5 low volatility 30d: long lowest stdev of daily log returns, short highest.
  - X6 lottery 30d: long lowest max daily return over 30 days, short highest.
- **Trial count:** N = 48 + 6 = **54** for the deflated Sharpe, sampled weekly, trial Sharpe variance measured over these six.
- **Window:** development only, Mondays 2021-03-01 → 2024-12-30. 2025-01 → 2026-10 stays sealed; it is read once, for at most
  one frozen variant, and only if that variant passes all seven checks below.
- **Acceptance (weekly net returns, every check required):**
  1. ≥ 100 weekly observations.
  2. Mean net > 0 and one-sided 90% lower bound > 0 (month-clustered bootstrap, `Bootstrap.ts`).
  3. Mean net > 0 in both halves: 2021-03 → 2022-12 and 2023-01 → 2024-12 (replaces "2 of 3 symbols").
  4. Mean net > 0 at 1.5× costs.
  5. Basket sizes Q = 4 and Q = 8 both have mean net > 0.
  6. Observed net mean exceeds the 95th percentile of the **cost-free** mean (gross price return + funding) of 2,000 random-selection portfolios (same universe, Q). The random side pays no costs, which is conservative against the signal.
  7. Deflated Sharpe probability > 0.95 with N = 54.
- **Reported, not gated:** market beta of the weekly return against the equal-weight universe return; gross vs cost vs
  funding split; mean net with the best 5% of weeks removed; per-symbol contribution of the five largest contributors.
- **Power, stated before results:** the smallest weekly mean this sample can separate from zero is computed from the
  realised weekly volatility and printed with every report; an effect below it is "untestable at this sample", not a fail
  of the bars.

## 14. Addendum (pre-registered 2026-11-14, before any new-listing return was computed) — short new perp listings

**Research only** (same mandate note as §13).

- **Edge:** newly listed perpetuals are bought on listing hype and underperform the market over the following weeks, as
  new equity issues do. The other side: late retail buyers of the listing pump.
- **Events:** every USDⓈ-M USDT perp whose first daily bar is at least 60 days after the panel start (so the listing is
  observed, not assumed), from the full archive including delisted contracts. Listing day L = first daily bar.
- **Trade:** short the new perp at the daily open of day L+D, hold H days, exit at the daily open of day L+D+H (last close
  if it stops trading earlier; a delisted contract exits at its last close). Hedge: long BTCUSDT for the same notional over
  the same open-to-open span, so the result is the alt's return in excess of BTC, not market direction.
- **Costs:** 6 bps per side on both legs (24 bps per event). Funding: actual settlements in (entry, exit]; the short
  receives positive funding on the alt, the BTC long pays it. Stress: 3× costs, because new-listing spreads are wider.
- **Variants (4):** D ∈ {3, 7} × H ∈ {7, 21}. N = 54 + 4 = **58**.
- **Window:** events with entry in 2021-03-01 → 2024-12-30 (development). 2025-01 onward stays sealed.
- **Acceptance (net excess return per event, every check required):**
  1. ≥ 100 events.
  2. Mean net > 0 and one-sided 90% lower bound > 0 (month-clustered bootstrap: same-month listings share market risk).
  3. Mean net > 0 in both halves (entries before / from 2023-01-01).
  4. Mean net > 0 at 3× costs.
  5. All three other (D, H) variants have mean net > 0.
  6. Mean exceeds the 95th percentile of 2,000 random draws that short one existing contract (≥ 90 bars of history, 30-day
     volume ≥ 10 M USDT) on each event's entry day for the same H, hedged the same way, cost-free.
  7. Deflated Sharpe probability > 0.95 with N = 58 (per-event Sharpe, `sampleLength` = events; approximate because events
     overlap in time). The trial Sharpe variance is the larger of the one measured across the four variants and 9.29e-3 (the §10 value), so four similar variants cannot make the bar lenient.
- **Reported, not gated:** worst single event, 1st/99th percentile of event returns (an unhedged short has unlimited
  loss; no stop is modelled), events per year, share of events from the 10 largest-volume symbols.

### §13/§14 result (development window, run 2026-11-14)

`npx tsx scripts/xsection-backtest.ts` → `research-runs/xsection-dev-20261114T0943Z.json`; `--listings` for §14; `--diagnose X4`.
All verdicts by the rules fixed above. Nothing was changed between registration and the run.

| Variant | Net %/wk | 90% LCB | Both halves | 1.5× cost | Q4 / Q8 | Beats random p95 (0.88%) | DSR (N=54) | Checks |
|---|---|---|---|---|---|---|---|---|
| X1 momentum 14d | +0.54 | −0.22 | yes | yes | yes | no | 0.003 | 4/7 REJECTED |
| X2 momentum 28d | +1.06 | +0.30 | yes | yes | yes | yes | 0.020 | 6/7 REJECTED |
| X3 reversal 7d | −1.35 | −2.10 | no | no | no | no | 0.000 | 1/7 REJECTED |
| **X4 funding rank 7d** | **+1.52** | **+0.75** | yes | yes (+1.45) | +2.65 / +1.42 | **yes** | 0.112 | **6/7 REJECTED** |
| X5 low volatility 30d | +0.55 | −0.28 | yes | yes | no | no | 0.005 | 3/7 REJECTED |
| X6 lottery 30d | +0.18 | −0.56 | no | yes | yes | no | 0.001 | 3/7 REJECTED |

| Listing short (D, H) | Mean net per event | 90% LCB | Events | Both halves | 3× cost | Beats random p95 | DSR (N=58) | Checks |
|---|---|---|---|---|---|---|---|---|
| 3, 7 | +2.86% | +0.98% | 294 | yes | yes | yes (0.98%) | 0.035 | 6/7 REJECTED |
| 3, 21 | +7.11% | +3.17% | 276 | yes | yes | yes (0.11%) | 0.200 | 6/7 REJECTED |
| 7, 7 | +1.02% | −1.27% | 291 | yes | yes | yes | 0.001 | 5/7 REJECTED |
| 7, 21 | +4.42% | −0.30% | 275 | yes | yes | yes | 0.043 | 5/7 REJECTED |

- By the pre-registered rule every variant is **REJECTED**; the sealed window stays closed. No rescue inside this addendum.
- X4 and the D=3 listing shorts are the strongest leads of the project: positive in both halves, positive at stressed
  costs, beat a random-selection baseline, and fail **only** the deflated Sharpe (N = 54 / 58 with weekly SD ≈ 9%).
- X4 per year (net %/wk): 2021 +3.29, 2022 +0.21, 2023 +0.70, 2024 +2.13; positive for all 7 rebalance weekdays
  (+1.25 to +2.07). Funding income is +0.38 to +1.22 %/wk in every year; the leg that earns the price part flips by year
  (long leg in 2021/2023, short leg in 2022), so it is not a one-sided bet. Max drawdown of cumulative weekly returns is
  −63% of one leg's notional (needs sizing at a fraction of capital). Mean with the best 5% of weeks removed: +0.29%.
  X4 returns are concentrated: the five largest symbol contributors (SOL, ETC, TRX, GALA, SAND) sum to ~190% of ~330% total.
- Listing shorts: the BTC hedge leg itself earned +1.4% to +4.7% on average (listings cluster in bull phases), so the
  *net* is beta plus alpha; the random-peer baseline carries the same BTC leg and is the fair comparator. Event tails are
  extreme (worst hedged event −460%, 1st percentile −99% to −179%): an unhedged short has unlimited loss, so sizing must
  assume the 1% worst case, not the mean.
- Power: weekly SD ≈ 9% gives a minimum detectable weekly mean ≈ 1.4% at 200 weeks (80% power, one-sided 10%). X4's
  +1.52% is only just above it, which is why the deflated Sharpe cannot clear 54 trials.

## 15. Addendum (pre-registered 2026-11-14, after §13/§14 results, before any replication-universe return was computed)

The §13 leads (X4 funding rank, X2 momentum 28d) failed only the deflated Sharpe. The sealed window is not spent on
leads. This addendum looks for **independent evidence in the development period**: the same frozen rules on symbols the
§13 universe never contained. A pass supports opening the sealed window for one variant; it does not replace that test.

- **Rules:** X4 and X2 exactly as §13 (same signals, Q = 6, costs, funding, weekly Monday rebalance, month-clustered bootstrap).
- **Universes (disjoint from §13, point-in-time, same filters):**
  - **B:** ranks 31–60 by 30-day quote volume at each rebalance.
  - **C:** ranks 61–90 (smaller caps; spreads are wider, so the cost-stress check uses **3×** costs instead of 1.5×).
- **Tests:** 4 (X4, X2 × B, C). Trial count N = 58 + 4 = **62**; deflated Sharpe is reported but not gated here, because
  the question is whether the §13 effect replicates, and the DSR bar was already applied to it in §13.
- **Replication rule (all required):** checks 1–6 of §13 pass (≥ 100 weeks; mean > 0 with 90% LCB > 0; both halves > 0;
  stressed-cost mean > 0; Q = 4 and Q = 8 > 0; beats the 95th percentile of the cost-free random baseline drawn from the
  same universe). A variant that passes in both B and C is "replicated"; in one of them only, "partial"; neither, "failed".
- Nothing about the signals, window or Q changes. Window stays 2021-03-01 → 2024-12-30.

### §15 result (run 2026-11-14)

`npx tsx scripts/xsection-backtest.ts --skip-top {30|60} --ids X4,X2 --gate-dsr false [--cost-stress 3]`

| Variant | Universe | Net %/wk | 90% LCB | Halves (21-22 / 23-24) | Stressed cost | Beats random p95 | Checks 1–6 | Verdict |
|---|---|---|---|---|---|---|---|---|
| X4 | B (31–60) | +0.60 | −0.47 | +1.56 / −0.29 | +0.52 (1.5×) | no (0.92) | 3/6 | failed |
| X2 | B | −0.18 | −0.99 | −0.76 / +0.36 | −0.25 | no | 1/6 | failed |
| X4 | C (61–90) | +0.24 | −0.48 | −0.10 / +0.56 | −0.07 (3×) | no (0.92) | 2/6 | failed |
| X2 | C | +0.04 | −1.06 | +0.39 / −0.29 | −0.26 | no | 1/6 | failed |

**Neither §13 lead replicates on disjoint symbols.** X2 disappears. X4 keeps a positive sign in both universes but is
indistinguishable from zero and fails the halves and baseline checks. Whatever X4 earned in the top-30 is not shown to
generalise to smaller caps, where it would also pay more cost. X4 is therefore a **lead that did not replicate**, not a
validated edge. The sealed window is not spent on it.

## 16. Addendum (pre-registered 2026-11-14, before any age, attention or positioning return was computed)

Four more cross-sectional weekly signals on the §13 machinery (top-30 universe, Q = 6, costs and funding as §13). N = 62 + 4 = **66**.
Each must pass **all seven** §13 checks, with the deflated Sharpe at N = 66.

- **X7 age:** long the oldest contract, short the youngest (§14 suggests recently listed perps underperform; this tests it
  inside the liquid universe). Score = days since the first daily bar.
- **X8 attention reversal:** short the highest 7-day surge in quote volume vs the prior 30 days (days m−37…m−8), long the
  lowest. Score = −(mean quote volume of days m−7…m−1 ÷ mean of days m−37…m−8).
- **X11 top-trader crowding:** contrarian to Binance's top-trader long/short **position** ratio at the last snapshot at or
  before Sunday 23:50 UTC (usable from 23:55, before Monday's open). Score = −ratio.
- **X12 open-interest build:** fade leverage building. Score = −(OI value at Sunday 23:50 ÷ OI value one week earlier − 1).
- **Windows:** X7, X8: Mondays 2021-03-01 → 2024-12-30 as §13. X11, X12: positioning archive starts 2021-12, so Mondays
  2022-01-03 → 2024-12-30 (about 156 weeks, still ≥ 100); the halves are 2022 vs 2023-24.
- Metrics are downloaded only for the Sundays used (Sunday snapshot and the Sunday before), for symbols that ever enter
  the §13 top-30.

### §16 interim (run 2026-11-14, X7 and X8 only; X11/X12 await the positioning download)

Correction recorded before relying on any number: X4's score has many **exact ties** (most contracts sit on the default
funding rate), and the first run broke them by floating-point noise. Ties are now ordered by a seeded pseudo-random key
(`runPortfolio(..., tieSeed)`) and funding sums are rounded to 1e-10 so identical rates tie exactly. X4 over 25 seeds:
mean net +1.47% / +1.56% / +1.63% (min / median / max) per week, so the tie rule does not drive the result. The panel now
starts 2019-09 so every contract's true listing day is visible (age); this changed no universe or return.

`npx tsx scripts/xsection-backtest.ts --ids X4,X7,X8 --trials 66`:

| Variant | Net %/wk | 90% LCB | Halves (21-22 / 23-24) | 1.5× cost | Q4 / Q8 | Beats random p95 (0.88) | DSR (N=66) | Checks |
|---|---|---|---|---|---|---|---|---|
| X7 age (long old, short young) | +1.20 | +0.37 | +0.79 / +1.58 | +1.19 | +1.46 / +0.58 | yes | 0.037 | 6/7 REJECTED |
| X8 attention reversal | −0.62 | −1.51 | −0.03 / −1.17 | −0.69 | no | no | 0.000 | 1/7 REJECTED |

X7 matches the §14 listing result (young contracts underperform) from a second angle and is positive in both halves,
but its deflated Sharpe fails like the others. By the §15 logic it gets the same independent-universe test, registered here
before it is run.

## 17. Addendum (pre-registered 2026-11-14, before any X7 return on universes B or C was computed)

X7 on the disjoint universes of §15: **B** (ranks 31–60) and **C** (ranks 61–90), rules unchanged, replication rule of §15
(checks 1–6; stressed cost 1.5× for B and 3× for C; deflated Sharpe reported, not gated). Trial count N = 66 + 2 = **68**.

### §17 result (run 2026-11-14)

`npx tsx scripts/xsection-backtest.ts --skip-top {30|60} --ids X7 --gate-dsr false [--cost-stress 3] --trials 68`

| Variant | Universe | Net %/wk | 90% LCB | Halves (21-22 / 23-24) | Stressed | Beats random p95 | Checks 1–6 | Verdict |
|---|---|---|---|---|---|---|---|---|
| X7 | B (31–60) | −0.66 | −1.65 | +0.58 / −1.81 | −0.69 | no | 1/6 | failed |
| X7 | C (61–90) | +0.35 | −0.55 | +0.12 / +0.57 | +0.20 (3×) | no (0.92) | 4/6 | failed (no LCB, no baseline) |

**X7 does not replicate.** Together with §15, every cross-sectional lead found in the top-30 universe failed on
non-overlapping symbols from the same period. The most likely reading is a sample-specific result in 30 liquid names,
not a general effect. Cross-sectional weekly rank portfolios are closed unless the positioning signals (X11, X12) differ.

## 18. Addendum (pre-registered 2026-11-14, after counting events but before computing any event return) — extreme-day moves

Event counts only were looked at to pick thresholds: the rule is the smallest round threshold giving at least 250 events
in the development window (pump ≥ +30% → 515 events, crash ≤ −25% → 265 events; at hold 7d, one open trade per symbol).

- **Edge:** a one-day extreme move in a liquid perp overshoots. Pumps fade; crashes bounce, because forced flow and
  attention, not information, drive the largest single-day moves.
- **Universe:** the §13 filters (≥ 90 bars, 30-day mean quote volume ≥ 10 M USDT), all contracts including delisted.
- **Events:** the day's close-to-close return ≥ +30% (PF, **short**) or ≤ −25% (CB, **long**), entered at the next daily
  open (00:00 UTC), exit D days later; a symbol with an open trade is not re-entered. BTC-hedged, costs 24 bps, funding,
  stress 3×, exits and exclusions exactly as §14.
- **Variants (4):** PF and CB × hold ∈ {3, 7} days. N = 68 + 4 = **72**.
- **Window:** entries 2021-03-01 → 2024-12-30; 2025-01 onward sealed.
- **Acceptance:** the seven checks of §14 with these changes: check 5 is "the other hold of the same direction has mean
  net > 0"; check 6 draws the random peer with the same direction; deflated Sharpe uses N = 72.
- **Reported, not gated:** per year, worst and 1st/99th percentile events, share of events on a market-wide move day
  (BTC's own day return beyond ±5%).

### §18 result (run 2026-11-14)

`npx tsx scripts/xsection-backtest.ts --moves`

| Variant | Events | Mean net | 90% LCB | Halves | 3× cost | Beats random p95 | DSR (N=72) | Checks |
|---|---|---|---|---|---|---|---|---|
| PF +30% short, H=3 | 556 | −0.50% | −2.10% | −2.36 / +1.38 | no | no | 0.000 | 1/7 REJECTED |
| PF +30% short, H=7 | 515 | −2.07% | −4.49% | −3.81 / −0.29 | no | no | 0.000 | 1/7 REJECTED |
| CB −25% long, H=3 | 273 | −1.12% | −3.89% | −0.14 / −6.22 | no | no | 0.000 | 2/7 REJECTED |
| CB −25% long, H=7 | 265 | +2.28% | −1.52% | +3.95 / −6.11 | yes | no (4.85) | 0.046 | 2/7 REJECTED |

No overshoot edge in either direction. Pumps keep running (short side loses in 2021 and 2024); crashes bounce only in
2021–22 and not after.

## 19. Addendum (pre-registered 2026-11-14, before any spot-hedged carry return was computed) — high-funding basket carry

**Research only; and it needs a spot account, which is outside the current mandate.** If it works, that is a decision for the user.

Why: X4's short leg earned its funding but carried price risk, and price risk is what the cross-section could not
replicate (§15, §17). Hedging the price away with spot keeps only the part that is paid for taking the other side of
leveraged longs: funding, plus the spot–perp basis change.

- **Selection:** each Monday, from the §13 top-30 universe (point-in-time), the **Q = 6** contracts with the highest summed
  settled funding over the prior 7 days (score = the X4 sum, higher first; ties by the seeded key), among those that have a
  Binance spot market (spot symbol = perp name with a leading `1000…` stripped; returns, not levels, are compared) with a
  spot open at entry and exit. No spot market → not eligible.
- **Position:** short the perp and long the same notional of spot, equal weight 1/Q each; entry at the Monday daily open of
  both, exit at the next Monday's open (last close of both if either stops trading). A name kept across weeks is not re-traded.
- **Weekly return per unit of notional:** Σ w × [ settled funding in (entry, exit] received by the perp short + (spot return
  − perp return) ] − costs. Costs per side on traded notional: perp 4 bps taker + 2 bps slippage; spot 10 bps taker + 2 bps
  slippage (no exchange-token discount assumed). Reported per unit of notional and per capital, with capital = **2× notional**
  (both legs fully funded; no liquidation to model, no borrow, no spot yield).
- **Trials:** one variant (Q = 6); Q = 4 and Q = 8 are the neighbour check. N = 72 + 1 = **73**.
- **Window:** Mondays 2021-03-01 → 2024-12-30; 2025-01 onward sealed.
- **Acceptance (weekly net returns, all required):** 1) ≥ 100 weeks; 2) mean net > 0 and one-sided 90% LCB > 0
  (month-clustered); 3) mean net > 0 in both halves; 4) mean net > 0 at 1.5× costs; 5) Q = 4 and Q = 8 > 0;
  6) mean exceeds the 95th percentile of the cost-free mean of 2,000 random baskets of 6 eligible names (same hedge);
  7) deflated Sharpe > 0.95 with N = 73 and trial Sharpe variance 0.0115, the value measured across the six §13 signals (this strategy's weekly SD is far smaller than the directional ones, so the bar is attainable).
- **Reported, not gated:** funding vs basis vs cost split, weeks with a negative net, worst week, share of weeks with fewer
  than 6 eligible names, per-year net, and the five largest contributors.

### §16 result, positioning signals (run 2026-11-14)

`npx tsx scripts/xsection-backtest.ts --ids X11,X12 --first 2022-01-03 --trials 66`

Data caveat found in the run: the archive's daily positioning files are missing for most 2022 Sundays, so only 111 (X11) and
108 (X12) of the 156 weeks have usable scores, almost all in 2023–2024. The "both halves" check is therefore not
informative (7 and 4 weeks in the first half).

| Variant | Weeks | Net %/wk | 90% LCB | Halves | 1.5× cost | Q4 / Q8 | Beats random p95 (0.88) | DSR (N=66) | Checks |
|---|---|---|---|---|---|---|---|---|---|
| X11 top-trader crowding fade | 111 | +0.84 | +0.18 | +0.39 (7) / +0.87 (104) | +0.79 | +0.71 / +0.80 | **no** (0.836 vs 0.877) | 0.108 | 5/7 REJECTED |
| X12 OI-build fade | 108 | −1.56 | −2.60 | +1.78 (4) / −1.69 (104) | −1.66 | −1.65 / −1.22 | no | 0.000 | 1/7 REJECTED |

X11 is positive but only just misses the random-selection bar and has a 2-year effective window. X12's sign is wrong:
open-interest builds are not followed by underperformance. Its mirror (follow OI build) would show about +1.6%/wk in
2023–24, but a mirror chosen after seeing the result is not evidence; it would need its own registration and fresh data.

### §19 result (run 2026-11-14)

`npx tsx scripts/xsection-backtest.ts --carry --trials 73` (spot daily klines mirrored to `data/cache/vision-spot`).

| Weeks | Net %/wk | 90% LCB | Halves | 1.5× cost | Q4 / Q8 | Beats random p95 (0.141) | DSR (N=73) | Checks |
|---|---|---|---|---|---|---|---|---|
| 200 | +0.101 | +0.021 | +0.177 / +0.030 | **−0.002** | +0.069 / +0.118 | **no** (0.101) | 0.076 | 4/7 **REJECTED** |

- The hedge works: the basis (spot − perp) averages +0.001%/wk. What is left is funding, +0.306%/wk gross, against
  0.206%/wk of costs (weekly turnover of the basket; spot taker alone is 12 bps per side), so net is +0.10%/wk per unit of
  notional, about +2.6% a year on 2× capital.
- By year (net %/wk): 2021 +0.54, 2022 −0.13, 2023 −0.05, 2024 +0.11. All the carry sits in the 2021 bull market; since
  2022 the highest-funding names pay roughly what trading them costs. 118 of 200 weeks are negative.
- Random baskets earn about the same cost-free funding (random p95 0.141 vs this net 0.101), so selecting on high funding
  adds nothing after costs. Funding carry on this universe is closed.

## 20. Consolidated result (2026-11-14)

Variant budget spent: **73 trials** (the 48 of §1–§12 plus 25 here). No variant passed all seven checks; none was
promoted; the sealed 2025-01 → 2026-10 window is **unread**.

| § | Family | Best result | Why it stops |
|---|---|---|---|
| 13 | Cross-sectional weekly L/S (X1–X6) | X4 funding rank +1.52%/wk, X2 momentum 28d +1.06%/wk, 6/7 | DSR; **no replication** on disjoint universes (§15) |
| 14 | Short new listings, BTC-hedged | D=3,H=21: +7.1% per event, LCB +3.2%, 6/7 | DSR at N=58; no independent window yet; tail −460% |
| 15 | X4/X2 on ranks 31–60 and 61–90 | +0.60%, +0.24%/wk, LCB < 0 | failed |
| 16 | Age, attention, top-trader, OI | X7 6/7 (age), X11 5/7 | X7 failed replication (§17); X11 only 2 years of data |
| 18 | Extreme-day pump fade / crash bounce | none | 1–2/7 |
| 19 | Spot-hedged high-funding carry | +0.10%/wk | costs; random baskets pay the same |

**The one lead left standing is §14 (short new perp listings against BTC).** Independent evidence for it can only come from
(a) the sealed 2025-2026 window, once, for one frozen variant, which is the user's decision, or (b) forward paper
trading of new listings. It needs no new capital class (perps only) but a wider universe than SOL/ETH/XRP.

## 21. Phase 1 — intraday opportunity map (registered 2026-11-14; descriptive, **adds no trials**)

Purpose: before testing any intraday entry rule, measure on the 1m path what a *signal-free* trade can do. It cannot approve
a strategy; it shows whether 1–10% moves are frequent enough to pay costs and what an entry rule would have to beat.

- **Data:** local 1m klines (mirror), development window 2021-01-01 → 2024-12-31, 13 contracts (BTC, ETH, SOL, XRP first).
  The sealed 2025-01 → 2026-10 window is not read.
- **Samples:** an entry every 30 minutes at the 1m open, both sides, no signal. Resolution on the 1m path: adverse level
  (stop) vs favourable level (target); both in the same minute → the stop; neither within the horizon → exit at the horizon
  close. Costs 12 bps round trip.
- **Grid (descriptive, fixed):** stop S ∈ {0.5%, 1%, 2%}, target T ∈ {1%, 2%, 3%, 5%, 10%}, horizon ∈ {4h, 24h, 72h}.
- **Benchmark:** a driftless path hits T before S with probability S/(S+T); an excess over that (before costs) is what an
  entry rule would be trying to find. Costs add 0.12% per trade against it.
- **Swing ceiling:** zigzag swings (reversal threshold r ∈ {1, 2, 3, 5, 10}%) on the 1m highs/lows per symbol and year, and the
  net a perfect trader would keep after 12 bps per swing. An upper bound only: it uses hindsight.
- **Not allowed to follow from it:** picking the best (S, T, hour, symbol) cell and trading it. Any rule that uses a cell must
  be registered separately, counted, and tested on data this map did not select it from.

### §21 result (run 2026-11-14)

`npx tsx scripts/opportunity-map.ts --symbols <13 contracts>` → `research-runs/opportunity-map-20261114T1022Z.json`
(1.82 M signal-free entries per cell, 2021–2024, both sides, 1m path, 12 bps costs).

- **A signal-free entry earns nothing.** Pooled over 13 contracts the gross expectancy of every (stop, target, horizon)
  cell is within ±0.03% per trade, so the net is the cost, about −0.12%, in every cell, side and year. Not one of the 90
  cell/side combinations is positive in all four years. Hit rates sit at or below the driftless benchmark.
- **What a rule must beat:** with a 1% stop and 3% target the break-even hit rate is 28.0% against a 25.0% benchmark; for
  5% it is 18.7% vs 16.7%; for 10%, 10.2% vs 9.1%. A rule needs about **+1 to +3 points of hit rate** over chance, or a
  gross edge above 0.12% per trade, in out-of-sample data.
- **Moves exist.** Zigzag swings (hindsight, one unit of notional): BTC 18–97 swings ≥ 10% a year, ETH 22–173, SOL 94–345,
  XRP 63–305; ≥ 3% swings run in the hundreds to thousands a year. Capturing even 1–5% of that ceiling would be a large
  return, so the problem is predicting them, not their frequency.
- Direction alone is not it: in 2021–2024 neither side's pooled net beats −cost in a consistent way (long loses most in 2022,
  short least; both flip sign by year).

## 22. Phase 2 — intraday multi-timeframe families with 1m entries (registered 2026-11-14, before any family was simulated)

Nine families, both sides, three variants each (27). N = 73 + 27 = **100** for the deflated Sharpe. Every signal is
evaluated on each **closed 1m bar**; the entry fills at the **next 1m open** (+ slippage); stops, targets, trails and time
exits resolve on the 1m path with the §3 rules (stop first on a same-minute touch; gaps through the stop fill at the open;
the trail ratchets on 1h closes, an engine limit). Higher timeframes (5m, 15m, 1h, 4h, 1d) are built from the 1m bars and
read only after they close. §1 gating applies: STRESS_CRASH blocks entries, HIGH_VOL halves size. One position per symbol.
Costs 12 bps round trip (+ real funding). **Symbols:** SOLUSDT, ETHUSDT, XRPUSDT; BTCUSDT is context only (F6).
**Window / protocol:** `--from 2020-11-01 --to 2025-01-01 --first-test 2021-07-01`, six-month train / three-month test
walk-forward (fourteen test folds), the seven §4 checks, matched random baseline and the 24h momentum benchmark; no rescue;
2025-01 onward sealed. ATR = Wilder 14 on the stated timeframe; EMA/RSI standard.

| Family | Context (higher timeframes) | 1m trigger and entry | Stop | Exit | Max hold | Variants |
|---|---|---|---|---|---|---|
| F1 trend pullback | 4h EMA50 vs EMA200 and 1h close vs 1h EMA50 agree (side) | within 8 closed 15m bars after 15m RSI14 ≤ P (long) / ≥ 100−P (short): a 1m close crosses back through the 1m EMA30 in the trend direction | 1.5 × ATR(15m) | trail 3 × ATR(15m), no target | 72h | P ∈ {30, 35, 40} |
| F2 breakout + retest | 1h close beyond the prior N-bar 1h channel; 4h EMA50 now vs 6 bars ago agrees | within 12h, first 1m bar whose low (long) / high (short) comes within 0.1 × ATR(1h) of the broken level and closes back on the breakout side; cancelled if a 1h close returns through the level | level ∓ 1.2 × ATR(1h) | trail 2.5 × ATR(1h) | 72h | N ∈ {24, 48, 96} |
| F3 sweep reversal | prior W 5m bars' range (excluding the forming bar) | a 1m bar trades beyond the range extreme and closes back inside, with 1m volume ≥ 2 × its prior-60-minute mean | sweep extreme ± 0.2 × ATR(15m) | target = range midpoint, skipped if reward < 1.5R | 12h | W ∈ {48, 96, 192} |
| F4 momentum ignition | none | 1m return ÷ stdev of the prior 240 1m returns ≥ Z in magnitude, 1m volume z (prior 240) ≥ 3, taker-buy share ≥ 0.65 (long) / ≤ 0.35 (short) | 1 × ATR(15m) | target 2R | 2h | Z ∈ {3, 4, 5} |
| F5 opening range | sessions starting 00:00, 08:00, 13:30 UTC; range = high/low of the first 30 minutes | first 1m close beyond the range after it forms; one trade per session | opposite side of the range, within [0.8, 3] × ATR(15m) | target 2R | 6h from session start | session ∈ {00:00, 08:00, 13:30} |
| F6 BTC lead (alts only) | none | BTC move over the last 5 minutes ≥ θ in magnitude and the alt moved ≤ 30% of it in the same direction; trade the alt in BTC's direction | 0.5 × ATR(15m) | target 1 × ATR(15m) | 1h | θ ∈ {0.3%, 0.5%, 0.8%} |
| F7 band reversion | range regime: |4h EMA50 − EMA200| / close < 2% | 1m bar trades beyond the 1h Bollinger(48, σ) band and closes back inside | 1m extreme ± 1 × ATR(1h) | target = 1h Bollinger mean, skipped if reward < 1.2R | 24h | σ ∈ {2.5, 3, 3.5} |
| F8 squeeze expansion | 1h Bollinger(24, 2) width percentile over the prior 720 1h bars ≤ P | at a 15m close beyond that band (in the 1h bar's direction), the next 1m open | 1.5 × ATR(1h) | trail 3 × ATR(1h) | 72h | P ∈ {10, 20, 30}% |
| F9 daily range break | 4h EMA50 vs EMA200 agrees; previous N completed UTC days' high/low | first 1m close beyond the N-day high (long) / low (short) | 1.5 × ATR(4h) | trail 3 × ATR(4h) | 7 days | N ∈ {5, 10, 20} |

- **Reported per variant (not gated):** long and short separately, per symbol, per year, gross vs cost vs funding R, the
  share of exits by reason (STOP/TARGET/INVALIDATED/TIME), average hold.
- **Power:** the number of trades is printed against `minimumDetectableEffect`; a family with too few trades is
  "untestable at this sample".
- **Exit sensitivity:** only for a family that shows positive gross edge (net R > 0 in training folds on at least 2 of 3
  symbols), and registered separately and counted before it is run.

## 23. Addendum (pre-registered 2026-11-14, after the first §22 run showed F9 at 6 of 7 checks, before F9 was run on any other symbol)

F9 (daily-range break, 4h trend filter, 1m entry) failed only the deflated Sharpe on SOL/ETH/XRP. The earlier daily-breakout
lead (L3, §10–§12) looked the same on SOL/ETH/XRP and then **failed on ten other perps**. So F9 gets the same test first,
frozen, before anything else is built on it:

- **Rules:** F9 exactly as §22 (N ∈ {5, 10, 20}; 4h EMA50 vs EMA200 trend filter; 1m close beyond the prior N completed
  UTC days' high/low; once per day per side; stop 1.5 × ATR(4h); trail 3 × ATR(4h); max hold 7 days; §1 gating; 12 bps).
- **Symbols (fixed, research only, same disclosure as §12):** BTCUSDT, BNBUSDT, ADAUSDT, DOGEUSDT, LINKUSDT, LTCUSDT, DOTUSDT,
  AVAXUSDT, TRXUSDT, BCHUSDT. Survivorship caveat as §12 (contracts alive today).
- **Window and protocol:** `--from 2020-11-01 --to 2025-01-01 --first-test 2021-07-01`, the seven checks with check 3 read
  as "positive on at least 7 of the 10 symbols"; N = 100 + 3 = **103**.
- **Reading it:** if F9 is positive on at least 7 of 10 symbols it replicates across contracts, which L3 did not; if not, F9
  is the same symbol-specific result as L3 and the daily-breakout family is closed.

### §22 result (run 2026-11-14, N = 100)

`NODE_OPTIONS=--max-old-space-size=12288 npx tsx scripts/g5-backtest.ts --from 2020-11-01 --to 2025-01-01 --first-test 2021-07-01 --strategies F1,…,F9 --trials 100`
→ `research-runs/g5-dev-2026-11-14T1030Z.json` (SOL, ETH, XRP; fourteen walk-forward test folds, 2021-07 → 2024-12).
Two engine/loader fixes preceded the final run and are covered by tests: a time exit that landed on a missing minute produced a
NaN price (now exits at the latest real price), and the hour index is now matched by time, not offset, because 2020–2022
archives have missing hours. A look-ahead test (`tests/intradaySignals.test.ts`) checks every family gives the same signals with and without future minutes.

| Family | Trades | Gross R | Cost R | Net R | 90% LCB | Symbols > 0 | vs random / momentum | Checks | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| F1 trend pullback | 2,958 | −0.049 | 0.161 | −0.214 | −0.260 | 0 of 3 | no / no | 1/7 | REJECTED |
| F2 breakout + retest | 1,283 | −0.004 | 0.080 | −0.089 | −0.149 | 0 of 3 | no / no | 1/7 | REJECTED |
| F3 sweep reversal | 19,013 | −0.048 | 0.440 | −0.488 | −0.512 | 0 of 3 | no / no | 1/7 | REJECTED |
| F4 momentum ignition | 13,982 | +0.036 | 0.304 | −0.268 | −0.285 | 0 of 3 | no / no | 1/7 | REJECTED |
| F5 opening range | 3,691 | −0.016 | 0.160 | −0.176 | −0.209 | 0 of 3 | no / no | 1/7 | REJECTED |
| F6 BTC lead | 2,674 | +0.032 | 0.327 | −0.296 | −0.340 | 0 of 3 | beats random / no | 1/7 | REJECTED |
| F7 band reversion | 894 | −0.041 | 0.123 | −0.162 | −0.234 | 0 of 3 | no / no | 1/7 | REJECTED |
| F8 squeeze expansion | 1,452 | +0.115 | 0.108 | +0.006 | −0.063 | 1 of 3 (SOL) | beats both | 2/7 | REJECTED |
| **F9 daily-range break** | 404 | **+0.221** | 0.037 | **+0.169** | **+0.043** | **3 of 3** (SOL +0.233, ETH +0.112, XRP +0.162) | **beats both** (−0.053 / −0.120) | **6/7** | REJECTED (DSR only) |

- Every short-horizon family (F1–F7) is negative before or because of costs: with stops of 0.3–0.6% the 12 bps round trip
  is 0.12–0.40R per trade (F3 0.44R, F4 0.30R, F6 0.33R), which is more than any gross edge found. Their gross is within
  ±0.05R of zero; F4 and F6 have a small positive gross that costs erase.
- F8 has a real gross (+0.115R) that costs cancel (+0.006R net); a cheaper entry would be a new, counted hypothesis.
- F9 is the only family positive on all three symbols, at 1.5× and 2× costs (+0.151R, +0.132R), with both parameter
  neighbours positive, and beats the matched random and momentum baselines. Its deflated Sharpe is ≈ 0 (daily SR 0.044,
  N = 100, trial Sharpe variance 7.2e-2 dominated by the very negative F3/F4 trials).

### §23 result — F9 breadth (run 2026-11-14, N = 103)

`… --strategies F9 --trials 103 --trial-sr-var 7.24e-2 --symbols BTC,BNB,ADA,DOGE,LINK,LTC,DOT,AVAX,TRX,BCH` → `research-runs/g5-dev-2026-11-14T1041Z.json`

| Trades | Gross R | Net R | 90% LCB | Symbols > 0 | 1.5× cost | Neighbour F9:10 | Beats random (−0.008) / momentum (−0.085) | DSR | Checks | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,590 | +0.092 | **+0.040** | −0.044 | **7 of 10** | +0.019 | +0.028 | yes / yes | 0.000 | 5/7 | REJECTED |

Per symbol (net R / trades): BTC +0.173/156, BNB +0.159/163, ADA +0.128/153, TRX +0.113/156, AVAX +0.073/172, DOGE +0.027/154, DOT
+0.005/166, BCH −0.009/152, LINK −0.098/169, LTC −0.179/149.

- Unlike L3 (4–5 of 10 symbols, net −0.012R), F9 is positive on 7 of 10 contracts and beats random and momentum, so it
  is not just the SOL/XRP result seen in the first run. The effect outside SOL/ETH/XRP is small (+0.04R, lower bound below zero),
  which is why checks 2 and 7 fail.
- Verdict by the §23 rule: **not a pass, but the first family to replicate in sign across contracts.** The sealed
  2025-2026 window is still unread.

### §24 F9 as a portfolio (descriptive, run 2026-11-14; no trial added)

`--dump-trades` on F9 over 13 contracts, entries 2021-07 → 2024-12. Winners average +2.1R, losers −0.91R, win rate 31–33%,
average stop 3.7% of price, average hold 1.4 days (the 3 × ATR(4h) trail ends trades early). Shorts earn more than longs (F9:10 all 13:
short +0.080R vs long −0.006R; F9:20: +0.176R vs +0.014R).

| Book | Net R/trade | Trades | 0.5% risk per trade | 1% risk per trade |
|---|---|---|---|---|
| F9:10, all 13 contracts | +0.031 | 1,891 | ×1.24, CAGR 6%, max drawdown **−39%** (2021 −2%, 2022 −7%, 2023 +8%, 2024 +25%) | ×1.32, max drawdown −64% |
| F9:5, SOL/ETH/XRP | +0.116 | 514 | ×1.32, CAGR 8%, max drawdown −13% | ×1.67, CAGR 16%, −24% |
| F9:10, SOL/ETH/XRP | +0.039 | 425 | ×1.07, CAGR 2%, −14% | ×1.10, −26% |
| F9:20, SOL/ETH/XRP | +0.142 | 338 | ×1.25, CAGR 7%, −9% | ×1.52, CAGR 13%, −17% |

The edge is real in sign but small. On 13 correlated contracts (up to 13 open at once) a +0.03R/trade expectancy gives
6% a year for a 39% drawdown; on the three in-mandate contracts 2–16% a year at 14–26% drawdown, which is within the
noise of the sample (the in-mandate rows are also the subset F9 was first seen on). It is not a tradable edge by itself.

## 25. Consolidated intraday result (2026-11-14)

Trial budget spent: **103**. Intraday 1m-entry families F1–F8 (every timeframe from 5m to 4h, both sides, 24 variants): all
negative or flat after 12 bps; stop widths of 0.3–0.6% make cost 0.1–0.44R per trade. F9 (multi-day trend break with a 1m
trigger) is the single family with positive net on all of SOL/ETH/XRP and 7 of 10 other contracts, but its expectancy is
+0.03 to +0.14R and it fails the lower-bound and deflated-Sharpe checks outside SOL/ETH/XRP. The sealed window is unread.

## 26. One-shot read of the sealed window (registered 2026-11-14, before it was read; user asked to try every remaining option)

**Option 1 (smart-money signals) — not testable for futures.** The Binance `trading-signal` endpoint serves history (pages 50 and
200 still return rows) but only for Solana/BSC DEX tokens (pump.fun style names), none of which has a Binance perpetual or
a price archive here, so no signal can be turned into a perp trade. Closed without a test.

**Option 3 — F9 on the sealed 2025-01-01 → 2026-10-31 window, once.** Frozen before reading:
- **Rule:** F9 exactly as §22 on SOLUSDT, ETHUSDT, XRPUSDT. **Primary: N = 20** (the modal walk-forward selection on the
  in-mandate symbols); N = 5 and N = 10 are reported as neighbours. No other change of any kind.
- **Data:** the local mirror, 1m klines and mark prices from 2024-10 (indicator warm-up only) through 2026-10; trades counted only
  if they enter on or after 2025-01-01. Breadth symbols have no mirror past 2024-12, so they are not tested.
- **Pass (primary variant, all required):** ≥ 40 trades; mean net R > 0 with a one-sided 90% day-clustered bootstrap lower bound
  > 0; mean net R > 0 on at least 2 of 3 symbols; mean net R > 0 at 1.5× costs; mean above the matched random baseline.
  A pass supports forward paper trading, not live capital. A fail closes F9.
- This uses the window. Nothing tuned or selected afterwards may claim it as out-of-sample.

### §26 result — F9 on the sealed window (run 2026-11-14, read once)

`scripts/g5-backtest.ts --from 2024-10-01 --to 2026-11-01 --first-test 2025-01-01 --strategies F9`, trades entering 2025-01-01 → 2026-10; per-variant statistics from
`--dump-trades` (day-clustered bootstrap, 4,000 draws).

| Variant | Trades | Mean net R | 90% LCB | SOL / ETH / XRP | 1.5× cost | 2025 / 2026 | Long / short |
|---|---|---|---|---|---|---|---|
| **F9:20 (frozen primary)** | 172 | **+0.135** | **−0.078** | +0.04 / +0.47 / −0.08 | +0.114 | +0.30 / −0.05 | +0.33 / −0.04 |
| F9:10 | 214 | +0.092 | −0.104 | −0.01 / +0.32 / −0.04 | +0.070 | +0.26 / −0.11 | +0.26 / −0.04 |
| F9:5 | 253 | +0.191 | −0.007 | +0.14 / +0.42 / +0.01 | +0.169 | +0.41 / −0.05 | +0.41 / +0.02 |

**Verdict by the §26 rule: the frozen primary fails** (lower bound below zero). It keeps a positive mean, positive on 2 of 3
symbols and at 1.5× costs, but the edge is concentrated in ETH and in 2025 (long side), and **2026 is flat to slightly
negative in all three variants**. The walk-forward-selected mixture the harness reports (+0.284R, LCB +0.063, all three symbols positive)
is not the frozen rule and is not used. As a book on SOL/ETH/XRP the frozen F9:20 made ×1.11 at 0.5% risk per trade
(CAGR 6%, drawdown −9%). The sealed window for F9 is now spent; F9 is closed as a validated edge.

## 27. One-shot read of the sealed window for the listing short (registered 2026-11-14, before it was read)

The user asked for every remaining option, so the second lead is tested the same way as F9 (§26).
- **Rule:** §14 exactly, **primary D = 3 days, H = 21 days** (the best development variant, fixed in advance); the other three
  (D, H) are neighbours. Every USDⓈ-M USDT perpetual whose first daily bar falls in 2025-01-01 → 2026-10-05 and whose entry (day L+3) is in
  that range; exits need data through 2026-10-31. Short the listing against a BTC long, 24 bps costs, funding both legs, no stop.
- **Pass (primary, all required):** ≥ 40 events; mean net > 0 with a one-sided 90% month-clustered lower bound > 0; mean net > 0 in
  both 2025 and 2026; mean net > 0 at 3× costs; mean above the 95th percentile of the cost-free random-peer baseline;
  all four variants' means > 0. A pass supports forward paper trading of new listings (small size: the dev tail was −460%), not live capital.
- Run: `npx tsx scripts/xsection-backtest.ts --listings --listings-sealed`.

### §27 result — listing short on the sealed window (run 2026-11-14, read once)

`npx tsx scripts/xsection-backtest.ts --listings --listings-sealed` (events entering 2025-01-01 → 2026-10-05, ~500 per variant).

| (D, H) | Events | Mean net | 90% LCB | 2025 / 2026 | 3× cost | Random p95 | Checks | Verdict |
|---|---|---|---|---|---|---|---|---|
| 3, 7 | 507 | +0.37% | −2.70% | −1.68 / +2.22 | −0.11% | 1.97% | 1/7 | REJECTED |
| **3, 21 (frozen primary)** | 507 | **−5.50%** | **−21.01%** | −14.60 / +2.74 | −5.98% | 4.23% | **1/7** | **REJECTED** |
| 7, 7 | 499 | −1.27% | −6.01% | −4.84 / +2.06 | −1.75% | 2.40% | 1/7 | REJECTED |
| 7, 21 | 499 | −7.45% | −21.40% | −15.96 / +0.50 | −7.93% | 4.45% | 1/7 | REJECTED |

**The listing short fails the frozen test.** The typical event still wins (median +8.8%, 63% win rate; without the worst 5 events the
mean is +7.2%), but the sealed window contains tail events that wipe the mean out (worst hedged event −5,396%: a perp that rose
more than 50× while short; 1st percentile −175%). With no stop, the rule's average is dominated by a few unbounded losses, which
is what the development tail (−460%) hinted at. A stop rule is a **new hypothesis** on data that has now been read; it cannot be
confirmed on this history and is only testable going forward (§28). The sealed window is now spent for both leads.

## 28. Forward-only test (registered 2026-11-14; entries before this date are labelled retrospective and do not count)

History is exhausted: every dataset here has been used for development or the sealed read. The only honest evidence left is forward.
Frozen, nothing may be changed after the first forward event:
- **Listing short with a hard stop:** every new USDⓈ-M USDT perpetual (Binance `onboardDate`); short at the daily open of day L+3, BTC
  long hedge for the same notional, **hard stop 30% above the entry** (checked on daily highs; a day opening above the stop fills at its
  open), exit at the open of day L+24, costs 24 bps, real funding on both legs.
- **Sample and pass:** at least 100 forward events; mean net > 0, month-clustered one-sided 90% lower bound > 0, mean net > 0 at 3× costs.
  **Correction found when the tracker first ran:** Binance now lists only about 2–3 USDT perpetuals a month (exchange info: 2026-06 to 2026-10 shows 7, 3, 2, 3, 2),
  not the ~23 a month the archive averaged in 2025–2026 (that count included contracts since delisted). 100 forward events would take about three years, so
  this is a **monitor, not a usable test**; it is kept because it costs nothing, and no conclusion is drawn before 100 events. Any rule change restarts the count.
- **Tooling:** `scripts/shadow-listings.ts`, run once per day; journal `data/shadow/listings.jsonl`, state `data/shadow/listings-state.json`.
  No orders are placed; it reads public exchange info and klines only.
