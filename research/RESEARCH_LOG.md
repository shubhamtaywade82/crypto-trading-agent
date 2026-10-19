# Research program log — SOLUSDT USDⓈ-M perpetual (ALMA + SMC/ICT)

Status as of 2026-10-19. Every study below was predeclared: definitions,
families and gates were committed (and pushed where noted) before results
were inspected. All verdicts are net of taker/maker fees, slippage and actual
historical funding unless stated otherwise. Data: data.binance.vision archive
klines + funding (fapi is IP-banned in the build sandbox), manifests with
SHA-256 lineage under `data/research/**/manifests/` (gitignored).

## Completed studies

| # | Study | Commit(s) / PR | Verdict |
|---|---|---|---|
| 1 | ALMA(9/21) event families (cross / cross+slope / pullback-reject), 730d × 5 TFs × 2 horizons, inverted-direction negative control | PR #42, 400cacc | **NULL** — no powered edge after costs; external 65.6% 2h claim was regime luck (51.3% over 901 events); slope filter harmful |
| 2 | SMC/ICT component-ablation stage-1 grid, 62 variants / 25,921 steps / 90d | PR #41 | **NULL** — zero variants reached the 30-fill train gate (fill-starved); holdout never opened |
| 3 | Sweep-and-reclaim Stage A (descriptive, 730d + train/test split) | 50b9f22 | Candidate: 4h/1h SHORT side held train→test (60.3% pooled, median +0.548%/24h) — later shown to be a stopless-measurement artifact |
| 4 | Sweep-and-reclaim Stage B (cost-adjusted chase-entry, narrow stops, 24 configs) | 0b78a30 | **REJECTED** — 0/24 Holm-significant; win rate collapses 60.3% → 36.8–52.2% once a structure stop is in the path |
| 5 | Sweep-and-reclaim Stage C (wider stops 0.5–2.0 ATR, train-first, contamination declared) | 71e4cfc, a34f84c | **REJECTED** — 0/30 train-gate passes, best raw p = 0.159; Stage-B marginal cells do not replicate train-only (+0.067 → −0.062); wider stops cut cost-in-R but gross edge stays ~0.05–0.14R |

Key methodological findings so far:

- Descriptive hit rates without a stop in the measurement path overstate
  tradability: MAE is absorbed into the horizon close.
- The 146d test window and the 365d earlier-history replication window
  (2023-10-19 → 2024-10-18) were NEVER consumed: Stage C had zero survivors,
  so per the survivors-only protocol they remain untouched.

## Stage D (this branch)

| # | Study | Branch | Status |
|---|---|---|---|
| 6 | Sweep-and-reclaim Stage D — limit-at-level (retest) execution model: resting limit at the swept level, maker entry fees, fill window 6/12 bars, both sides, stop buffers 0.25/0.5/1.0 ATR, stop-or-2R / stop-or-time48 exits (24 configs). Train → test → replication discipline identical to Stage C. | `research/sweep-stage-d` | **REJECTED** — 0/24 train-gate passes (best raw p = 0.0502; Holm needs 0.00208). All 24 configs positive under the optimistic intrabar convention — the first uniformly positive family — but a sensitivity audit showed the near-miss cells are convention-fragile (short buf0.25 W12: +0.253 → −0.024 under the conservative bound). Convention-robust no-target cells stay positive under both bounds but never approach significance (p 0.17–0.31; lottery profiles). Holdouts preserved. Verdict: `research/alma/reports/sweep-staged-verdict.md` |

## Program status

Sweep-and-reclaim on SOLUSDT is **closed**: descriptive promise (A) was a
stopless-measurement artifact; chase entry (B), stop placement (C) and the
retest entry model (D) all fail the predeclared train gates. ALMA event
families and the ablation grid are null (1, 2). The only unconsumed assets
are the 146d test window and the 365d replication window — reserved for the
next predeclared family that survives a train gate. The written hypothesis
for any future study is cross-sectional (pooled symbols/meta-analysis),
not more parameter tuning on this instrument.

## Standing conventions

1. Definitions and families are committed before any result inspection.
2. Signals confirm on bar close; earliest entry reference is the next bar
   (Stage B/C: next open; Stage D: resting limit fill after the close).
3. Conservative intrabar ordering: stop fills before target; gap-through-stop
   fills at the open.
4. Costs are explicit per side and per order type; funding uses actual
   settlements from the archive.
5. Family-wise inference: seeded sign-flip permutation p-values + Holm
   step-down; chronological folds as a continuity check; gates require fill
   counts, significance, positive expectancy and fold consistency.
6. Holdout windows open only for train survivors, once, per family.
7. A research pass is not live admission — the repository's own promotion
   gate still applies.
