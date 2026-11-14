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
