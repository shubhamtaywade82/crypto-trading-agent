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
