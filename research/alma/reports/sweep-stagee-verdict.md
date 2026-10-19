# Stage E verdict — cross-asset (BTC+ETH pooled) replication of the sweep-and-reclaim families

**Verdict: REJECTED at the train gate. 0 / 48 predeclared configs pass. Zero survivors, so
the untouched test (146d) and replication (365d) windows on BTC/ETH were NOT evaluated,
per the survivors-only protocol.**

- Predeclaration: commit `67d1485` on `research/sweep-crossasset`, pushed BEFORE any
  BTC/ETH data was fetched or any Stage-E evaluation ran.
- Train report: `data/research/alma/events/sweep-eval-stagee-train.json`
  (config sha256 `356fa833e97a`, window 2024-10-18 → 2026-05-25, 584d).
- Data: BTCUSDT + ETHUSDT 4h (3,504 bars each in-window) and 1h (14,016 bars each),
  data.binance.vision archive, zero missing days, manifests
  `bf09bab9…`/`dc3f68e9…` (4h) and `42294cdf…`/`00173320…` (1h).

## What was tested

The two previously frozen families applied VERBATIM to fresh instruments, pooled per config
(48 tested configs, Holm α = 0.05 across all):

- **Market-entry (Stage-B replica, 24):** {4h,1h} × {short,long} × buffer {0.25,0.5} × ATR14
  × exits {time6, stop_or_2R, stop_or_1.5R}; next-bar-open entry; taker 4 bps + 2 bps slip
  per side; conservative intrabar ordering; actual historical funding per symbol.
- **Retest-entry (Stage-D replica, 24):** 4h × {short,long} × buffer {0.25,0.5,1.0} × fill
  window {6,12} × exits {stop_or_2R, stop_or_time48}; maker entry at the swept level;
  **plus the predeclared pessimistic clause** — a config can only pass if net E[R] > 0 with
  same-bar fill→target exits NOT honored (the Stage-D audit lesson, now inside the gate).

Pooling rules: permutation on the pooled union of filled-trade R values (order-invariant,
seed 20261021, 10k iterations); 4 chronological folds over the shared UTC timeline;
per-symbol splits reported as diagnostics only.

## Results

**No config reaches the train gate.** Holm across 48 requires the smallest p ≤ 0.00104;
the best raw pooled p is 0.0852. Sign consistency is absent (18/48 positive; 10/24 retest
configs pessimistic-positive). Selected cells:

| config | filled | E[R] opt | E[R] pess | p | folds | verdict driver |
|---|---|---|---|---|---|---|
| retest 4h short buf0.5 W6 stop_or_2R | 159/222 | +0.158 | +0.101 | 0.0852 | +0.01/+0.15/+0.45/+0.02 | not Holm-significant |
| retest 4h short buf0.5 W12 stop_or_2R | 177/222 | +0.137 | +0.069 | 0.1101 | −0.11/+0.24/+0.38/+0.03 | not Holm-significant |
| market 4h long buf0.5 stop_or_2R | 207 | +0.081 | — | 0.2126 | +0.04/+0.27/+0.02/−0.00 | not Holm-significant |
| market 4h short buf0.25 stop_or_2R | 222 | −0.005 | — | 0.5157 | −0.04/−0.19/+0.21/−0.01 | E[R] ≈ 0 |
| market 1h short buf0.25 stop_or_2R | 870 | −0.260 | — | 1.0000 | −0.26/−0.22/−0.38/−0.18 | uniformly negative |

Per-symbol diagnostics (the Stage-B short-side candidate does NOT transfer):

| config | BTC | ETH |
|---|---|---|
| market 4h short buf0.25 stop_or_2R | n=111, E[R] −0.136, p 0.845 | n=111, E[R] +0.126, p 0.179 |
| market 4h short buf0.5 stop_or_2R | n=111, E[R] −0.032, p 0.595 | n=111, E[R] +0.019, p 0.443 |

## Diagnostics

1. **The SOLUSDT Stage-A/B short-side candidate is dead cross-sectionally.** On BTC+ETH the
   market-entry short side earns ≈ 0 pooled, and the per-symbol split shows OPPOSITE signs
   (BTC −0.14 vs ETH +0.13 at buf0.25) — the signature of noise, not of a shared mechanism.
2. **1h sweep fading is reliably toxic on BTC+ETH**: all 12 market cells negative (mean
   −0.195R), every fold negative in every cell, drawdowns 100–240R over 850–870 events per
   side. This is a well-powered negative result, not an underpowered one.
3. **The strongest remaining pattern in the whole program** is retest 4h short buf0.5
   stop_or_2R: positive on BOTH symbols individually (BTC n=85 E[R] +0.157; ETH n=74
   E[R] +0.159) and under BOTH intrabar conventions (+0.158 opt / +0.101 pess pooled), with
   folds never deeply negative. It still fails the gate (pooled p 0.085 vs 0.001 needed; each
   symbol alone p 0.17–0.23; median trade −1R; DD 9–12R). It is recorded here as an
   untested observation ONLY: any pursuit would require a NEW predeclared study on fresh
   data (more symbols / longer history), declared before running.
4. **Long-side retest no-target cells (+0.27..+0.30)** are lottery profiles (win 12–16%,
   median −1R, sawtooth folds −0.80/+1.90) — the same few-giant-winners artifact identified
   in Stage D.

## Program conclusion

The sweep-and-reclaim event family has now been rejected on three instruments and seven
predeclared studies: SOLUSDT Stages A (descriptive artifact), B (0/24), C (0/30), D (0/24),
and the BTC+ETH pooled replication (0/48) — alongside the ALMA event-family null and the
ablation-grid null. A mechanism that exists should have appeared when pooling two of the
deepest perpetual books; it did not. The cross-sectional direction the program reserved for
last is now exhausted at this rigor level: **accept the null and close the family.**

Untouched resources preserved for any genuinely new predeclared hypothesis: the 146d SOL
test window, the 365d SOL replication window, and (after this study) the BTC/ETH test and
replication windows, which remain virgin because no Stage-E config survived training.
