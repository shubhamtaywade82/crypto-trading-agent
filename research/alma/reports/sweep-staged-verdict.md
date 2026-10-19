# Stage-D verdict — limit-at-level (retest) execution model (SOLUSDT)

**Verdict: REJECTED — 0 of 24 predeclared configs passed the train gate. No test or replication run (survivors-only protocol; both holdout windows remain unconsumed). The suggestive near-miss pattern does not survive the conservative intrabar-path bound.**

- Predeclaration: branch `research/sweep-stage-d`, commit pushed before any Stage-D run (family, gates, fee schedule frozen in code)
- Primary window: TRAIN 584d (2024-10-19 → 2026-05-26), 4h, 109 short / 106 long sweep events
- Report: `data/research/alma/events/sweep-eval-staged-train.json` (gitignored; config sha256 `5f7b930d0f1c`)
- Statistics: seeded sign-flip permutation p (10k, seed 20261021), Holm step-down α=0.05 over the 24-config family, 4 chronological folds, predeclared gates (n≥30 filled, Holm-sig, E[R]>0, ≥3/4 folds positive)

## 1. What was tested

Stages B (chase entry, narrow stops) and C (wider stops) rejected the sweep-and-reclaim family with next-open entry. Stage D tested the last mechanistically distinct lever: the execution model. A resting limit at the swept pivot level (maker entry, 2 bps, no slippage) fills only if price retests the level within 6 or 12 bars; degenerate fills are excluded; unfilled events are counted (adverse selection is inside the measurement). Family: 4h × {short, long} × buffers {0.25, 0.50, 1.00} ATR × fill windows {6, 12} × exits {stop-or-2R, stop-or-time48} = 24 configs, Holm over all of them. Fees: maker entry; taker 4+2 bps stop/time exits; maker 2 bps target exits; actual historical funding; full-taker-entry sensitivity reported per config.

## 2. Train results

Zero configs passed the gate. Best raw permutation p = 0.0502 (short buf0.25 W12 stop_or_2R); Holm over 24 requires 0.00208. Nothing was close after correction.

The landscape, however, is unlike every prior stage: **all 24 configs were net-positive** (E[R] +0.086…+0.456) under the shipped (optimistic) intrabar convention — the first family in this program with uniform sign. Representative cells:

| side | buffer | window | exit | n | E[R] (optimistic) | p | folds |
|---|---|---|---|---|---|---|---|
| short | 0.25 | 12 | stop_or_2R | 99 | +0.253 | 0.0502 | +0.21/+0.29/+0.54/+0.04 |
| short | 0.25 | 6 | stop_or_2R | 90 | +0.250 | 0.0599 | +0.19/+0.34/+0.55/−0.03 |
| long | 0.50 | 6 | stop_or_2R | 89 | +0.264 | 0.0506 | +0.13/+0.40/+0.28/+0.23 |
| long | 0.25 | 6 | stop_or_time48 | 89 | +0.456 | 0.2074 | +0.36/+0.89/−0.16/+0.87 |

Fill rates were high (82–91% of events retested the level within 12 bars); zero degenerate fills; the taker-entry sensitivity costs only ~0.03R (maker entry is not load-bearing).

## 3. The sensitivity that decides it

The retest simulator must resolve one intrabar ambiguity OHLC cannot: on the fill bar, when the target zone is also touched and the stop is not, did price reach the level (fill) *before* the target (exit +2R), or the target first (no exit; trade continues)? The shipped simulator credits the exit (optimistic). A pessimistic convention (fill-bar target touches never exit; trade continues) is the conservative bound, in the same spirit as the repo's stop-before-target rule.

Re-running every config under both conventions:

- The near-miss cells are **convention-fragile**: short buf0.25 W12 stop_or_2R +0.253 → **−0.024**; short buf0.25 W6 +0.250 → +0.047; long buf0.50 W6 +0.264 → +0.196. The p≈0.05 pattern is carried by 12–15 same-bar fill+target cases per config (13–15% of fills at buf0.25) and does not survive the conservative bound.
- The no-target cells are **convention-immune** by construction (no target, no ambiguity) and stay positive under both bounds (+0.10…+0.46) — but they are lottery profiles (median ≈ −1R, win rate 13–31%, drawdown 19–31R) and were never close to significance (p 0.17–0.31).
- Sign consistency survives the conservative bound (23/24 configs positive) — suggestive of a weak upward shift from retest execution, but nowhere near family-wise significance.

Honest reading: E[R] for the fragile cells lies somewhere in [pessimistic, optimistic], an interval that spans zero for every config that approached significance. The predeclared rejection stands with extra force.

## 4. Protocol discipline

Zero train survivors → the untouched 146d test window and the 365d replication window (2023-10-19 → 2024-10-18) were not evaluated. They remain the program's only unconsumed holdouts, available to the next predeclared family that earns them.

## 5. Program-level conclusion

The sweep-and-reclaim execution space is now exhausted on SOLUSDT 2023-2026:

| Stage | Lever tested | Verdict |
|---|---|---|
| A | Descriptive event statistics | Candidate (4h/1h shorts) — later shown to be a stopless-measurement artifact |
| B | Cost-adjusted chase entry, narrow stops | Rejected (0/24 Holm) |
| C | Stop placement (wider stops), train-first | Rejected (0/30 train gate) |
| D | Entry model (limit-at-level retest, maker fees), train-first | Rejected (0/24 train gate); near-miss cells convention-fragile |

Across ~50 predeclared configs in Stages B–D plus ~900 event-study cells, nothing cleared family-wise significance with a real exit path. The single most robust observation left standing is the convention-immune no-target retest profile (both sides, all buffers positive under both bounds) — a lottery-shaped, non-significant pattern that would need an order of magnitude more events (more history, more symbols, pooled meta-analysis) to even test properly, not more parameter tuning. Recommendation: close the sweep program on this instrument; treat the retest/no-target profile as a written hypothesis for a future cross-sectional study, not a tuning target.
