# SMC/ICT component-ablation experiment framework

**Status:** implemented 2026-10-19, branch `feat/smc-ablation-framework`. **Depends on:** the Phase 1 audit (2026-10-18), the playbook registry v3, and the causal replay (`src/playbooks/replay.ts`). **Scope:** the research milestone the repository audit asked for — a versioned, reproducible component-ablation experiment framework built around the existing replay engine. Nothing here touches the live order path, the orchestrator, or the registry playbooks' semantics.

---

## 1. The question this answers

The audit's final decision: *"The next implementation milestone should be a versioned, reproducible SMC/ICT component-ablation experiment framework built around the existing replay engine. It should be possible to answer, with out-of-sample evidence, whether a liquidity sweep helps, whether an FVG adds incremental value, whether a killzone filter improves expectancy, and whether a combination outperforms its individual components after costs."*

The risk it manages is selection bias: an ablation study tests dozens of rule-set variants, and some will look profitable by chance. The framework therefore fixes the whole procedure — variants, split, seeds, gate — before the holdout is read, corrects across the whole tested family, and reports negative controls beside every promoted candidate.

## 2. Decisions

1. **Components are rules and params, not new detectors.** A component group maps to playbook rules (`liquidity_swept_before_break`, `displacement_confirmed`, `htf_aligned`, ...) and, where a component cannot be a rule (zone kind, session windows), to a versioned `PlaybookParams` field. One detector per concept stays (audit §1.1); the ablation layer only composes what the rule engine already evaluates.
2. **Two new core capabilities, both backwards compatible:**
   - `session_in_window` (CONTEXT rule): the trigger close must fall inside `params.sessionWindows` (UTC). Fails closed without windows. Registry validation refuses a session rule without windows.
   - `params.zoneKinds`: restricts the arming zone to FVG and/or ORDER_BLOCK (default unchanged: FVG, then OB). The sweep reversal requires an FVG zone, validated.
3. **Variants are registry-faithful.** Every variant keeps the base playbook's id and version; its rules are the registry's order with toggleable rules removed or restored; `full` reproduces the registry definition exactly plus the research param overrides. Every variant passes the same `validateRegistry` as the registry: a variant can never be weaker than the mandatory core.
4. **One causal replay for the whole family.** `replayPlaybooks` gained `journalFor(pb)` so each variant writes its own journal (setup ids collide when variants share a journal) while the frame analyses stay shared and cached. Pending outcomes resolve for every journal used.
5. **The holdout is read once per config hash.** The study id is `symbol-days-configHash8`; the same id resumes its journals (append-only, dedup by setup id) and a changed config starts a new study directory instead of mixing evidence.
6. **Promotion is not live admission.** A PROMOTED variant is a research candidate only. The live gate remains `calibration.ts DEFAULT_ADMISSION_POLICY` (200 outcomes, 20 days, E[R] lower bound > 0.05 R).

## 3. Module map

| Module | What it does |
| --- | --- |
| `src/research/ablation/types.ts` | Config schema (v1), variant/metrics/manifest types, ICT killzone preset. |
| `src/research/ablation/variants.ts` | Component catalog per playbook (htf, sweep, displacement, unmitigated, fresh, volume, discount, zone, session), registry defaults, and the generator for core / full / `iso:` / `abl:` / `pair:` families. |
| `src/research/ablation/metrics.ts` | Journal records → trade records (MAE/MFE and cost share scanned from candles), per-segment metrics (E[R], PF, win rate, max drawdown in R, holding time, day-clustered bootstrap, direction/session/volatility-regime splits). |
| `src/research/ablation/stats.ts` | Day-floored chronological segments; mirror (flip) null; seeded sign-flip permutation test; delayed-entry controls; cost curve by re-resolving outcomes at multiplied fee+slippage. |
| `src/research/ablation/fingerprint.ts` | Canonical-JSON sha256 of the config and per-frame content hashes of the dataset. |
| `src/research/ablation/study.ts` | The runner: replay → per-segment metrics → fixed selection procedure → Holm across the family → controls for selected variants → `REPORT.md`, `results.json`, `manifest.json`, `config.json`. |
| `src/research/ablation/config.ts` | `DEFAULT_ABLATION_CONFIG` (fixed before the first real study ran). |
| `scripts/ablation-study.ts` | CLI (`npm run research:ablation`). |
| `tests/ablationStudy.test.ts`, `tests/playbookSessionZone.test.ts` | 14 tests: variant structure, segments, metrics, controls, seeded end-to-end study, session/zone rules. |

## 4. Experiment procedure (fixed, versioned with the framework)

1. **Variants.** Per playbook: `core` (mandatory rules + armed + trigger window + break + zone + target), `full` (registry defaults), every core-plus-one `iso:` option, every full-minus-one `abl:` for components the registry has on, and `pair:` combinations over the configured group keys (each at its registry-default option).
2. **Replay.** All variants in one causal pass over `[from, to]`: decisions only at their own 5m trigger close, limit entry at the zone edge resting `entryTtlBars`, stop tested before target within a bar, taker fee + slippage on both legs, spread is a stated assumption.
3. **Segments.** Train 50% / validation 25% / holdout 25% of the decision timeline, boundaries floored to UTC days. Metrics are computed per segment for every variant.
4. **Selection.** Eligible on train: filled ≥ `minTrainFilled` and train E[R] > 0; ranked by the train day-clustered bootstrap lower bound; the top `topK` continue. Validation must confirm positive E[R] before the holdout is consulted.
5. **Family correction.** Every variant with a computable holdout bootstrap p (one-sided, H0: E[R] ≤ 0) is in the Holm family at `alpha` — including the losers. A selected variant must be Holm-rejected to be promoted.
6. **Promotion.** Considered + holdout filled and distinct-day minimums + positive holdout lower bound + Holm-rejected.
7. **Controls** (for selected variants, holdout basis when it has evidence, else the full window, and always labelled): mirror flip null, sign-flip permutation test, delayed entries (+1/+2/+4 bars, re-resolving the same plan), cost curve at 0.5×–3× fee+slippage.
8. **Reporting.** Every result reports net E[R] in R, win rate, profit factor, fill rate, drawdown in R, holding time, MAE/MFE, cost share in R, and splits by direction, session and volatility tercile — per segment. The manifest pins framework version, playbook registry version, git sha, node version, seeds, config hash and dataset fingerprints.

## 5. Default config and the trigger window

`DEFAULT_ABLATION_CONFIG` sets `paramOverrides: { maxTriggerBars: 24 }` and `entryTtlBars: 24`. Rationale (audit §9-§10): the approved 6-bar trigger window produced zero decisions in 90 days of SOLUSDT; 12 bars gave 4 valid setups and 24 gave 9. These overrides exist so the study can collect outcomes at all; they are recorded in every manifest, the registry stays v3, and the values were fixed before the first study ran — they are not tuned on any outcome.

## 6. First real run (validation of the machinery, not a result)

SOLUSDT, 30 days to 2026-10-17, archive data, spread 1 bps, 62 variants, one causal pass: 8,641 steps, 135 decisions, 135 outcomes, 8.3 s. Every variant with fills is at or below its cost line (e.g. `breakout_retest::core` full-window E[R] −1.542 R over 4 fills); nothing reached 30 filled train trades, so nothing was promoted and the holdout was scanned only for the Holm family. This matches the documented Phase 1 reality (§10: 4 decisions in 270 symbol-days): the playbooks are effectively inactive as defined, and the framework's first finding is exactly that. Wider windows (more symbols, more history) are the audit's option 1 and need no code change — only a longer `--days` and more `--symbol` runs.

## 7. Not done here

- No integration into the orchestrator, the order path, or the calibration gate — research plane only.
- No funding in outcomes (unchanged from the playbook engine), no tick-level or order-flow features (that is `nemesis-crypto-trading` territory per the audit).
- One symbol per study; multi-symbol studies are repeated runs compared by study id.
- Regime split is descriptive (ATR terciles over the study's own decisions), not a causal regime model.
