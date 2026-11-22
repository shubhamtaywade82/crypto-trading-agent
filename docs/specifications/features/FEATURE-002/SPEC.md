# FEATURE-002: Derivatives Crowding & Positioning Engine

## Overview
Comprehensive derivatives crowding, positioning asymmetry, and squeeze vulnerability engine for crypto perpetual futures. Combines top-trader accounts vs global retail long/short divergence, taker volume aggression, rolling Open Interest (OI) leverage expansion, and funding rate percentiles into a normalized behavioral crowding score and squeeze vulnerability index.

## Problem
Trading agents currently lack insight into participant positioning and leverage concentration. Taking long breakout trades when retail participants are overwhelmingly long with expanding open interest leads to severe long-squeeze and liquidation risk. Conversely, heavily short-crowded conditions at key support provide prime fuel for violent short squeezes.

## Scope
### In Scope
- Top-trader vs global long/short ratio divergence metric
- Taker buy/sell volume aggression and order flow imbalance
- Open Interest expansion and leverage accumulation tracking
- Funding rate percentile and distribution analysis
- Normalized positioning crowding index from -1.0 (extreme short) to +1.0 (extreme long)
- Squeeze vulnerability classification (LONG_SQUEEZE_RISK, SHORT_SQUEEZE_RISK, NEUTRAL)
- Backward-compatible enhancement of CrowdingSnapshot in MarketState

### Out of Scope
- Statistical regime and mean-reversion filters (deferred to FEATURE-003)
- Multi-timeframe signal fusion matrix (deferred to FEATURE-004)
- Live exchange order execution and cancel-replace routing

## Actors
- StrategyEngine: Filters trend breakouts into crowded extremes to prevent buying into bull traps
- SetupEngine: Identifies contrarian squeeze setups (crowding extreme + opposing liquidity sweep + structure confirmation)
- RiskEngine: Adjusts exposure and stop distances when squeeze vulnerability is elevated

## Functional Requirements
- REQ-001: System shall compute top-trader vs retail positioning divergence from derivatives snapshots
- REQ-002: System shall evaluate taker buy/sell volume aggression ratio and delta
- REQ-003: System shall calculate Open Interest rate of change to identify leverage buildup
- REQ-004: System shall calculate funding rate percentile relative to market baseline
- REQ-005: System shall compute a composite normalized Crowding Index from -1.0 to +1.0
- REQ-006: System shall evaluate Squeeze Vulnerability based on crowding extreme and OI expansion

## Non-Functional Requirements
- NFR-001: Crowding evaluation must complete in under 2ms per derivatives snapshot
- NFR-002: All calculations must be pure, deterministic functions without network side effects

## Acceptance Criteria
- ACC-001: Top trader bias ratio is accurately computed with zero-division safety
- ACC-002: Normalized crowding index smoothly spans -1.0 to +1.0 and flags extremes
- ACC-003: Squeeze vulnerability flags trigger when crowding extreme coincides with expanding open interest
- ACC-004: Incomplete or null derivatives snapshots return safe neutral defaults without throwing
- ACC-005: All unit and regression tests pass deterministically via npm test

## Edge Cases
- Missing or zero global long/short ratio (division by zero guard)
- Zero or flat open interest change
- Extreme negative or positive funding rate anomalies during market dislocations
- Null derivatives snapshot when exchange data feed is unavailable

## Dependencies
- Binance derivatives feed and indicators
- Existing Market types (CrowdingSnapshot, DerivativesSnapshot)
