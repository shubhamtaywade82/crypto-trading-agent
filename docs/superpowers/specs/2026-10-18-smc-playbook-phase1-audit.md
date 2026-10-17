# SMC/ICT Playbook Engine: Phase 1 audit

**Status:** audit complete; Phase 1 decisions approved 2026-10-18 (§6). The only code change is the SMC-ML entry pause. **Date:** 2026-10-18. **Scope:** Phase 1 of the playbook plan only: audit the existing SMC modules, fix one feature schema, define explicit 5m confirmation. Phases 2 to 5 wait for review of this document.

Every claim below was checked against source or the installed SDK typings on this branch. Items marked UNVERIFIED were not checked.

---

## 1. Decisions

1. **One detector per concept.** FVG and order-block detection live only in the SMC-ML engine. Playbooks consume its output and do not add a second detector.
2. **5m is an explicit trigger, not a context timeframe.** Playbooks are armed on 15m and 1h structure. A setup becomes ENTRY_ELIGIBLE only on a closed 5m trigger (§4).
3. **Order placement is out of scope for Phase 1.** Before any playbook is wired to orders, the SMC-ML order path must be shown to pass the same risk gate (§3, finding A).

## 2. The SDK claims in the plan

| Plan claim | Result | Evidence |
| --- | --- | --- |
| `@nemesis-oss/binance-sdk` is an npm dependency | Confirmed, version 3.0.0 installed | `node_modules/@nemesis-oss/binance-sdk/package.json` |
| `new BinanceClient({ testnet, safety })` | Confirmed | `BinanceClientOptions`, `testnet?`, `safety?: RiskGatewayOptions` (SDK `dist/index-C06A22Dz.d.ts:5940-5982`) |
| `safety`: `readOnly`, `allowedSymbols`, `maxNotionalPerOrder`, `maxLeverage` | Confirmed | `RiskGatewayOptions` (SDK typings lines 143-154, 322) |
| `futures.market.klines(symbol, interval, options)` | Confirmed | SDK typings line 2796 |
| `futures.data.openInterestHist(symbol, period, limit)` | Confirmed | SDK typings line 4365 |
| `futures.data.fundingRateHistory(symbol, options)` | Confirmed | SDK typings line 4358 |
| `client.syncTime()` on the top-level client | **Not confirmed.** Only `core.syncTime()` appears in the typings (line 1292 and the module docs). Check before use. | SDK typings |
| "Read-only during research" | Supported by `safety.readOnly`. Not yet applied in this repo. | `SmcMlRuntime.ts:124` constructs the client with no `safety` option |

## 3. Findings in the existing code

**A. A second order path already exists.** `SmcMlRuntime` submits orders directly through the SDK: `client.futures.ops.closePosition` (line 261), `sizePosition` (line 271) and `placeBracketOrder` (line 285). This path is separate from `RiskAgent` and `ExecutorAgent`. Whether it calls `RiskEngine` or the kill switch was **not verified** in this pass. It needs the same treatment as the MiniCPM path (spec 2026-10-17, R1): nothing may reach `placeBracketOrder` without the repo's risk gate. Treat this as a blocker for any playbook that routes through SMC-ML.

**B. There is no 5m trigger.** Every setup trigger in `SetupEngine` is 15m: `timeframe: '15m'` at lines 185, 228 and 282, and triggers such as `'15m close above …'` (line 191). Zones in `StructureLiquidityStrategy` are restricted to 15m and 1h (line 126). This matches the plan's warning: a 15m break does not prove that a 5m entry is ready.

**C. The setup lifecycle is partly present.**
- `SetupState` is `FORMING | ARMED | TRIGGERED | INVALIDATED | NO_TRADE` (`SetupTypes.ts:16`).
- `SetupVerdict` is `ENTRY_ELIGIBLE | WATCH | NO_TRADE` (`SetupTypes.ts:53`).
- Invalidation reasons are `INVALIDATION_BREACHED | THESIS_EXPIRED | OPPOSING_TRIGGER` (`SetupTypes.ts:67`).
- **EXPIRED is not a `SetupState`.** It appears as a ledger outcome (`SetupOutcomeLedger.ts:7`) and as a terminal in `SetupLedger`. The plan's lifecycle should use the existing names and add EXPIRED as a state in one place.

**D. FVG and order blocks have one owner.** Literal FVG and OB kinds are in `src/strategies/smc-ml/` (`SmcMlEngine.ts`, `SmcConfluence.ts`, `types.ts`). `src/market/ZoneEngine.ts` has no FVG or OB kind, so the plan's concern about two competing detectors is not present in the current code. Keep it that way.

**E. Outcome labels for calibration exist, but no calibrator does.** `SetupOutcome` is `OPEN | TP1 | SL | EXPIRED | INVALIDATED | NOT_FILLED | UNRESOLVED` (`SetupOutcomeLedger.ts:7`). That is the label set the TP-before-SL calibrator needs. No calibrator exists. The Brier score that exists (`AgentLedger.ts:156`) scores LLM persona predictions, not setups.

**F. Replay is causal in the way the plan requires.** Decisions at a bar close fill at the next bar's open, with half-spread, slippage and fees (README; `ReplayService.ts:82`).

**G. Baseline.** The existing fleet replay shows E[R] = −0.248 over 227 trades with exit management off (README). The plan's warning applies.

**H. Not verified.** The claim that `MarketStateBuilder` builds its main structure state on 15m, 1h and 4h. Displacement, premium/discount and OTE are not in the detectors checked here, so they are undefined until Phase 2 defines them.

## 4. Canonical feature schema (proposed, Phase 2 to implement)

One record per symbol and closed bar, built by the SMC-ML engine and read by the playbooks. Every field is computed from closed bars only.

```ts
export interface SmcFeatureSnapshot {
  symbol: string;
  timeframe: '5m' | '15m' | '1h' | '4h' | '1d';
  barOpenTime: number;          // closed bars only; the bar's close time is barOpenTime + interval
  bias: 'LONG' | 'SHORT' | 'NEUTRAL';
  structure: { lastBos: StructureEvent | null; lastChoch: StructureEvent | null; protectedSwingHigh: number | null; protectedSwingLow: number | null };
  liquidity: { equalHighs: number[]; equalLows: number[]; sweeps: SweepEvent[] };
  zones: { fvg: GapZone[]; orderBlocks: OrderBlockZone[] };   // from SMC-ML only
  displacement: { atrMultiple: number; bar: number } | null;   // definition: PROPOSED, see §5
  atr14: number;
}
```

Derivatives and execution context (funding, open interest, taker flow, spread, depth) are a separate `ExecutionContext`. Each field carries its source timestamp so that stale data can be detected.

## 5. Explicit 5m confirmation (proposed)

Playbooks arm on 15m or 1h context. A setup becomes ENTRY_ELIGIBLE only when all of these hold:

1. **Armed.** The setup is ARMED on 15m, with its invalidation level and target defined.
2. **Trigger on a closed 5m bar.** For a LONG, the 5m bar closes above the 5m swing high that was the last break in the setup's direction. For a SHORT, the mirror image. The swing length `N` is a versioned parameter.
3. **Within age.** The trigger bar is no more than `max_age_bars` 5m bars after the setup armed. Default: 6 bars, PROPOSED, to be calibrated.
4. **Not overrun.** The 5m close has not passed the setup's invalidation level or the far edge of its zone.

`displacement` is defined as bar range or body divided by ATR14 on the forming timeframe, above a threshold that is versioned. The threshold is PROPOSED, not calibrated. No playbook may use "strong displacement" without this definition.

## 6. Phase 2 entry criteria

- The owner has accepted §3A, the plan for the SMC-ML order path. Either it goes through the risk gate, or it is paused as MiniCPM was. **Approved 2026-10-18: paused.** `SmcMlRuntimeOptions.entriesEnabled` defaults to false. OPEN and ADD are refused before any venue call, and EXIT still runs (`tests/smcMlEntryPause.test.ts`).
- The owner has accepted the 5m trigger definition in §5, or has set different parameters. **Approved 2026-10-18 as proposed.** The 6-bar age and the displacement threshold remain uncalibrated parameters.
- The SDK's `syncTime` path is confirmed (§2). **Open.**

Phase 2 then implements the playbook registry and the rule evaluator, each rule returning `{ ruleId, passed, reason, observedValue, threshold, evidenceTime }`, with NO_TRADE as an explicit outcome.

---

## 7. Phase 2: playbook registry and rule evaluator (implemented 2026-10-18)

Code is in `src/playbooks/`. Tests are in `tests/playbooks.test.ts`. Nothing is wired to the orchestrator, replay or orders yet: that is Phase 4.

### Pipeline

1. **`buildPlaybookContext`** keeps closed bars only (`openTime + interval <= now`), sorted and unique. It refuses invalid OHLC, gaps and conflicting duplicates, and runs `analyzeSmcFrame` on exactly those bars. FVG, order-block and break indices therefore always refer to the candles the rules read. A frame with a data problem is left out, and its problem is recorded in `dataIssues`.
2. **`deriveFacts`** locates, for one playbook and one direction: the zone-frame break, the entry zone, the structural stop, the arming event, the first 5m trigger after arming, the target, and the plan. It never reads the SMC outcome fields (`retestOutcome`, `followThroughOutcome`), because they resolve with later candles.
3. **Rules** (`RULES`) judge the facts. Each has a stage.
4. **`evaluatePlaybook`** applies the stages in order:
   - Any CONTEXT or SETUP failure gives NO_TRADE.
   - Otherwise, any TRIGGER failure gives WATCH. EXECUTION rules are then listed as `pending`, not failed.
   - Otherwise, any EXECUTION failure gives NO_TRADE.
   - Otherwise the result is ENTRY_ELIGIBLE, with the plan.
   - It never throws. A rule or derivation error fails closed with its message.
5. **Registry** (`PLAYBOOK_REGISTRY_VERSION = 1`) holds the three playbooks, each at version 1. It is validated at load:
   - no unknown or duplicate rule;
   - every stage present;
   - the mandatory rules present (`frames_present`, `data_fresh`, `structural_stop_defined`, `setup_not_invalidated`, `trigger_confirmed`, `stop_geometry_valid`, `net_reward_risk_above_minimum`);
   - params consistent.

### Frames and arming

All three playbooks use bias frames 4h and 1h, zone frame 15m, and trigger frame 5m.

| Playbook | Zone | Armed when | Stop |
| --- | --- | --- | --- |
| `sweep_mss_fvg_reversal` | FVG of the displacement leg (between the protected swing and the break) | The 15m CHOCH candle closes | Protected swing − 0.2 ATR |
| `bos_fvg_ob_continuation` | That FVG, else the break's order block | The first 5m bar after the break trades into the zone | Protected swing − 0.2 ATR |
| `breakout_retest` | The broken level ± 0.15 ATR | The first 5m bar after the break touches the band and closes back beyond the level | min(retest extreme, band far edge) − 0.2 ATR |

Common to all three:

- **Trigger.** The first 5m break in the trade direction whose bar opened at or after arming. This is the approved §5 definition: a closed 5m bar beyond the last 5m swing.
- **Entry.** The trigger's close.
- **Target.** The nearest untaken liquidity beyond the entry: the 15m frame first, then 4h, then 1h.

### Rule definitions (thresholds in the registry; all are starting values, not calibrated)

| Rule | Stage | Passes when |
| --- | --- | --- |
| `frames_present` | CONTEXT | 4h, 1h, 15m and 5m all analysed |
| `data_fresh` | CONTEXT | Every frame's last closed bar is less than 1 bar behind the clock |
| `htf_not_opposed` / `htf_aligned` | CONTEXT | No bias frame trends against the direction / every bias frame trends with it |
| `structure_break_in_direction` | SETUP | The latest 15m break is in the direction and of the required type (CHOCH, BOS, or ANY) |
| `liquidity_swept_before_break` | SETUP | The break's leg took the prior opposing swing (`sweptLiquidityFirst`) |
| `displacement_confirmed` | SETUP | Break body ÷ 15m ATR14 at the break ≥ 1.0 |
| `breakout_volume` | SETUP | Break volume ÷ mean of the prior 20 bars ≥ 1.5 |
| `entry_zone_present`, `zone_unmitigated` | SETUP | A zone exists, and no 15m bar has closed through its far edge since the break |
| `structural_stop_defined`, `setup_not_invalidated` | SETUP | A stop exists, and no 15m or 5m bar has closed beyond it (for a breakout, beyond the level band) since the break |
| `setup_fresh` | SETUP | Break age ≤ 16 bars of 15m |
| `target_liquidity_available` | SETUP | Untaken liquidity exists beyond the reference price |
| `trigger_window_open` | SETUP | The trigger closed within 6 bars of 5m after arming, or no trigger yet and fewer than 6 bars have passed. A failure means expired: NO_TRADE |
| `armed`, `trigger_confirmed` | TRIGGER | The arming event and the 5m trigger have printed |
| `spread_within_limit` | EXECUTION | Spread known and ≤ 5 bps |
| `stop_geometry_valid` | EXECUTION | Stop on the correct side; risk between 0.25 and 4 ATR |
| `entry_not_chased` | EXECUTION | Entry ≤ 0.5 ATR beyond the zone's near edge |
| `entry_in_discount` | EXECUTION | Continuation only: entry in the lower half of the displacement leg for a LONG, the upper half for a SHORT |
| `net_reward_risk_above_minimum` | EXECUTION | (reward − cost) ÷ (risk + cost) ≥ 1.5, with cost = entry × 2 × (taker fee + slippage) |

### Interpretations taken

- **"Not past the far edge of the zone" (§5)** is implemented as the chase gate (`entry_not_chased`). Read literally, a LONG 5m trigger that closes above its swing would almost always be past the top of the zone.
- **Displacement** is the break candle's body, not its range.
- **Order blocks** have no mitigation filter in the SMC engine, so `zone_unmitigated` applies one: no 15m close through the far edge.

### Not done in Phase 2

- Risk budget and sizing stay with `RiskEngine`. They are not duplicated here.
- No setup grade, no calibrated probability (Phase 3), no OTE and no derivatives or flow context.
- No live data adapter, replay integration or orders (Phase 4).
- The SDK `syncTime` question (§2) is still open. It matters only when Phase 4 adds the SDK data adapter.

---

## 8. Phase 3: outcomes, calibrated probability and grade (implemented 2026-10-18)

Code is in `src/playbooks/` (`grade.ts`, `outcome.ts`, `journal.ts`, `calibration.ts`), with a report script at `scripts/playbook-calibration.ts`. Tests are in `tests/playbookCalibration.test.ts`. Nothing is wired into the trading loop or replay yet (Phase 4), so the journal starts empty.

### Three separate outputs

| Output | Source | Used for |
| --- | --- | --- |
| Rule verdict | Phase 2 rule engine | Whether the setup is permitted |
| Grade (0 to 100, band A/B/C) | `gradeVerdict`, from the evidence the rules recorded | Ranking only. It is never a probability and never an input to one. It reaches the estimate only when the grade band is chosen as a bucket dimension, which is how one tests whether it ranks |
| Calibrated estimate | `estimateOutcome`, from resolved outcomes | The admission gate |

The grade has five components: context, break quality, location, reward and execution. Displacement, the sweep and the FVG are one event, so they form one component (break quality) rather than three votes.

### Outcome definition (fixed before any outcome is collected)

- **Outcome.** TARGET (TP before SL), STOP, or TIMEOUT within 48 bars of 5m (4 h), after taker fee and slippage on both legs. Funding is not modelled.
- **Fill.** Counted only when the first 5m bar after the trigger opens at or better than the limit, at that open. Live entries rest only 120 s, less than one bar, so a later touch inside the bar cannot be attributed. This undercounts fills, and the fill rate is reported with every estimate.
- **Exit.** Within a bar, the stop is tested before the target. A gap through the stop exits at the open.
- **Missing data.** Any gap, a missing first bar, or candles ending early gives UNRESOLVED. It is never written and never counted.

### Calibration

- **Buckets.** `playbook@version|direction` by default. The grade band can be added as a dimension.
- **No look-ahead.** An estimate at time *t* uses only setups decided before *t* and resolved by *t* (`knownAt`).
- **Estimate.** Over filled setups:
  - the probabilities of TARGET, STOP and TIMEOUT;
  - a Wilson interval on p(TARGET);
  - the mean net R per outcome;
  - E[R], with a one-sided lower bound from a day-clustered bootstrap at 95%. This reuses `src/research/Bootstrap.ts`.
- **Gate (`gateVerdict`).** An ENTRY_ELIGIBLE setup becomes NO_TRADE unless all of these hold:
  - at least 200 filled outcomes;
  - at least 20 distinct decision days;
  - an E[R] lower bound above 0.05 R at confidence 0.95.

  The day minimum is an added safeguard: with a single day, the day-clustered bootstrap collapses to the sample mean. The other values are the v1 contract's §8.
- **Calibration check (`prequentialCalibration`).** Walks setups in decision order and scores each against the rate known just before it, using a Beta(1,1) prior. It reports the Brier score of the bucket rate against the pooled rate, plus reliability bins. A bucket rate is informative only if it beats the pooled rate out of sample.

### Journal

`PlaybookJournal` is append-only JSONL.

- Each ENTRY_ELIGIBLE decision is stored once, keyed `playbook@version:symbol:direction:triggeredAt`, with the full rule evidence, the grade and the bucket.
- Each outcome is stored once.
- Reloading folds the file back, so a restart never records a setup or outcome twice.
- Unreadable lines are counted, not ignored.

### Not done in Phase 3

- The journal is not fed yet. Until Phase 4 runs the playbooks through replay and live data, every bucket has n = 0, and the gate refuses every setup. That is the intended starting state.
- There are no derivatives or volatility bucket dimensions, and funding is not modelled in outcomes.
