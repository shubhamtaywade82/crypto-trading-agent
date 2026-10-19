# Stage-C verdict — wider-stop sweep-and-reclaim family (SOLUSDT)

**Verdict: REJECTED — 0 of 30 predeclared configs passed the train gate. No test or replication run (survivors-only protocol). The sweep-and-reclaim standalone-entry hypothesis is closed.**

- Predeclaration: commit `71e4cfc` (family, gates, statistics pushed to GitHub before any Stage-C run)
- Primary window: TRAIN 584d (2024-10-19 → 2026-05-26), 4h 3,504 bars / 1h 14,016 bars
- Report: `data/research/alma/events/sweep-eval-stagec-train.json` (gitignored; config sha256 `2a9e33497ce1`)
- Statistics: seeded sign-flip permutation p (10k, seed 20261021), Holm step-down α=0.05 across the 30 tested configs, 4 chronological folds

## 1. What was tested

Stage B rejected the narrow-stop family but left 4h-short cells at buffer 0.50 ATR marginally positive (+0.055..+0.085R, p 0.21–0.30) with a mechanistic hypothesis: sweep wicks overshoot the episode extreme, so a wider structure stop should survive the retest wick and let the reversal pay. Stage C predeclared the wider family — {4h, 1h} × short-only × buffers {0.50, 0.75, 1.00, 1.50, 2.00} × exits {stop-or-2R, stop-or-1.5R, stop-or-time48} = 30 configs, long side reported as untested mirror — with a declared contamination: the hypothesis was selected on the pooled 730d sample, so promotion requires the train gate AND the untouched 146d test window AND a fresh 365d earlier-history replication window (2023-10-19 → 2024-10-18, fetched and manifested, never loaded by any prior stage).

## 2. Train results (primary read)

No config reached Holm significance. Best raw permutation p = 0.159 (1h buf0.50 time48). Every tested cell failed at least one predeclared gate leg; 22 of 30 failed the fold-consistency leg.

Representative 4h short cells (n=109 each):

| buffer | exit | net E[R] | gross | costs | win | folds (q1..q4) | p |
|---|---|---|---|---|---|---|---|
| 0.50 | stop_or_2R | −0.062 | −0.016 | 0.049R | 33.9% | −0.11/−0.01/+0.05/−0.18 | 0.683 |
| 0.50 | stop_or_1.5R | +0.002 | +0.049 | 0.049R | 43.1% | +0.02/−0.01/+0.09/−0.08 | 0.502 |
| 1.00 | stop_or_1.5R | +0.022 | +0.052 | 0.033R | 44.0% | +0.13/−0.11/+0.06/+0.03 | 0.434 |
| 2.00 | stop_or_2R | +0.108 | +0.125 | 0.020R | 47.7% | +0.50/−0.26/+0.26/−0.01 | 0.178 |
| 2.00 | stop_or_time48 | +0.118 | +0.138 | 0.020R | 46.8% | +0.51/−0.19/+0.32/−0.12 | 0.182 |

1h short cells (n=445): every target-based exit is negative (−0.035..−0.126R); the no-target time48 cells show a lottery profile (median ≈ −1.05R, win 22–29%, drawdown 34–48R, p 0.16–0.38).

## 3. Why the hypothesis fails

1. **The mechanism works mechanically but not economically.** Widening the stop does exactly what the hypothesis predicted — costs-in-R fall (0.049R → 0.020R) and win rate rises (34% → 48%) — but gross expectancy does not grow with it (+0.05..+0.14R). The stop was not the binding constraint; the underlying forward drift after a sweep reclaim is simply near zero once the measurement has a real exit path.
2. **The fold structure is a sawtooth, not a trend.** The best cells alternate +0.5/−0.3/+0.3/−0.3 across chronological quarters — the signature of a few concentrated regime episodes rather than a persistent microstructure edge.
3. **Stage B's marginal cells were pooled-window artifacts.** 4h buf0.50 stop_or_2R: +0.067R pooled (Stage B) vs −0.062R train-only (Stage C). The pooled positivity came disproportionately from the then-unseen test-period fold — precisely the contamination Stage C declared up front.
4. **The mirror diagnostic contradicts Stage A.** On train-only data the long side outperforms the short side (4h long buf0.50 time48 +0.319R), inverting the Stage-A descriptive finding that held out-of-sample. When a "signal" flips which side carries the edge depending on window and measurement choice, it is noise structure, not market structure.

## 4. Protocol discipline

Zero train survivors → per the predeclared gates, the untouched 146d test window and the fresh 365d replication window were NOT evaluated (they exist precisely for confirmatory reads, not exploratory fishing). The replication snapshots remain fetched and manifested (`data/research/alma-repl/`, sha256 e0b454897b31…/d5acef26edcd…) for any future predeclared study.

## 5. Program-level conclusion

Three increasing levels of rigor, three rejections, on SOLUSDT 2023-2026:

| Stage | Question | Verdict |
|---|---|---|
| A (descriptive, 730d + train/test) | Does the reclaim close above/below the level? | Promising descriptively (60.3% hit, 4h shorts) |
| B (cost-adjusted, narrow stops) | Does it pay with fees, slippage, funding, real stops? | Rejected — 0/24 Holm-significant |
| C (wider stops, train-first + declared contamination control) | Was the stop placement the problem? | Rejected — 0/30 train-gate passes |

The descriptive 60.3% hit rate was an artifact of stopless measurement: without a stop in the path, MAE is absorbed into the 24h close. Under any structure stop the family's gross edge (~0.03–0.14R) does not clear family-wise significance. ALMA crosses, ALMA pullbacks and sweep-and-reclaim standalone entries are now all closed on this instrument and window.

Legitimate continuations — each would be a NEW predeclared study with its own fresh holdout, not an extension of this one: (a) sweep events as regime/context filters for other entry logic; (b) a different execution model (limit entries at the swept level, with explicit fill-probability handling); (c) cross-sectional replication on other instruments, only with a mechanistic reason to expect it. The default recommendation is to accept the null and stop tuning this family.
