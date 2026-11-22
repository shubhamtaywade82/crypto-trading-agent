# FEATURE-004: Multi-Timeframe Signal Fusion & Conflict Resolution Matrix

## Overview
Comprehensive Multi-Timeframe Signal Fusion & Conflict Resolution Matrix that unifies signals from SMC structure strategies, statistical mean-reversion strategies, and derivatives crowding models into deterministic, conflict-free TradeIntents.

## Problem
When multiple autonomous trading agents (trend-following, mean-reversion, contrarian crowding) operate concurrently, they generate conflicting signals (e.g. TrendAgent generates BUY on breakout while MeanReversionAgent generates SELL on overbought Bollinger touch, or CrowdingAgent signals SHORT SQUEEZE). Without an explicit conflict resolution matrix and multi-timeframe alignment hierarchy, agents compete, causing trade collisions, whipsaws, and catastrophic counter-trend fills.

## Scope
### In Scope
- Dedicated ConflictResolver with deterministic matrix rules:
  1. Regime Hierarchy: Strong trend regimes (TREND_UP/TREND_DOWN or ADX > 25) veto counter-trend mean reversion. Range/low-vol regimes prioritize confirmed mean reversion.
  2. HTF Structure Dominance: Higher timeframe (1h/4h) structure direction takes precedence over minor LTF noise unless an HTF liquidity sweep and CHOCH confirm a structural reversal.
  3. Extreme Crowding / Squeeze Precedence: Severe one-sided crowding (squeezeRisk = LONG_SQUEEZE_RISK / SHORT_SQUEEZE_RISK or smart money divergence) provides a contrarian override.
- Enhanced Evidence Scoring incorporating all three intelligence engines:
  - SMC Structure (BOS, CHOCH, liquidity sweep, discount/premium pricing)
  - Derivatives Crowding (smart money divergence, crowding score, squeeze risk, taker imbalance)
  - Statistical Mean Reversion (Bollinger + RSI re-entry, range favorability, rolling Z-score)
- Integration into SignalFusion and SignalFusionEngine preserving backward compatibility.

### Out of Scope
- Direct order routing or broker execution (handled by ExecutionPlanner / RemoteBroker)
- Portfolio position sizing and capital allocation (handled by PortfolioRisk)

## Actors
- Strategy Agents (TrendEnsembleAgent, StructureLiquidityAgent, MeanReversionAgent, CrowdingAgent): Propose directional candidate signals.
- CandidateScorer: Computes objective evidence scores across all market intelligence dimensions.
- ConflictResolver: Evaluates opposing signals against the resolution matrix and selects the dominant candidate or orders a stand-down.
- Orchestrator: Dispatches the winning TradeIntent to risk and execution gates.

## Functional Requirements
- REQ-001: System shall resolve directional conflicts (LONG vs SHORT) for the same symbol using a deterministic multi-timeframe matrix.
- REQ-002: System shall strictly veto mean-reversion candidates when HTF trend regime is active (TREND_UP or TREND_DOWN with ADX > 20).
- REQ-003: System shall elevate contrarian squeeze candidates when positioning extremes and squeeze risks are confirmed by derivatives crowding.
- REQ-004: System shall award confluence bonuses when HTF and LTF structural trends align.
- REQ-005: System shall order a STAND_DOWN when conflicting evidence is balanced within conflict margins and no structural rule dominates.

## Non-Functional Requirements
- NFR-001: Conflict resolution and signal fusion must execute in under 5ms per symbol.
- NFR-002: All conflict decisions must produce explicit, human-readable explanatory reasons.

## Acceptance Criteria
- ACC-001: Conflicting Long and Short signals in a trending regime resolve in favor of the trend direction.
- ACC-002: Conflicting Long and Short signals in a range regime resolve in favor of confirmed mean-reversion re-entry candidates.
- ACC-003: Opposite signals with extreme squeeze risk resolve in favor of the contrarian squeeze direction.
- ACC-004: Unresolvable close-score conflicts without matrix dominance trigger clean STAND_DOWN.
- ACC-005: All existing tests and new conflict matrix test suites pass cleanly via npm test.

## Edge Cases
- Equal evidence scores with no regime or structure dominance (must stand down).
- Counter-trend signal accompanied by HTF liquidity sweep and CHOCH (valid structural reversal override).
- Missing derivatives or microstructure data (falls back safely to structure and regime rules).

## Dependencies
- SMC Structure & Liquidity Engine (FEATURE-001)
- Derivatives Crowding Engine (FEATURE-002)
- Statistical Mean Reversion Engine (FEATURE-003)
