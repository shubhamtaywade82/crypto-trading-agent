# FEATURE-001: Market Structure & POI Liquidity Engine

## Overview
Comprehensive Smart Money Concepts (SMC) market structure and liquidity engine providing mathematical Break of Structure (BOS) with ATR buffer, protected swing Change of Character (CHOCH), Point of Interest (POI) order block mitigation tracking, Premium/Discount equilibrium pricing, and session liquidity sweeps.

## Problem
Trading strategies currently rely on simplistic indicator signals without understanding market structure, order block origin, structural trend protection, or liquidity draw. This leads to whipsaws during range expansion and bad entries into opposing order blocks.

## Scope
### In Scope
- Mathematical BOS detection with configurable ATR buffer confirmation
- Protected swing CHOCH structural trend reversal detection
- POI and Order block lifecycle ledger (Fresh, Tested, Mitigated, Invalidated)
- Premium and Discount equilibrium calculations
- Session liquidity pool sweep detection (Asia, London, NY)
- Unified structure evaluation aggregator

### Out of Scope
- Derivatives crowding and positioning engine (deferred to FEATURE-002)
- Statistical regime and mean-reversion filters (deferred to FEATURE-003)
- Live order execution and exchange routing

## Actors
- StrategyEngine: Consumes structure state and POIs to evaluate entries and exits
- RiskEngine: Uses protected swing highs and lows for structural stop placement

## Functional Requirements
- REQ-001: System shall compute swing highs and lows and confirm BOS only when candle close breaks structural swing by ATR buffer
- REQ-002: System shall identify CHOCH only when price breaks the protected swing extreme of the opposite trend
- REQ-003: System shall compute range equilibrium, premium, discount, and positionPct for structural swings
- REQ-004: System shall track order block cause zone lifecycle through fresh, tested, mitigated, and invalidated states
- REQ-005: System shall identify session liquidity pools and validate confirmed sweeps with close-back-inside logic
- REQ-006: System shall provide a unified evaluateStructureState aggregator returning complete SMC market context

## Non-Functional Requirements
- NFR-001: Structure and liquidity evaluation must complete in under 5ms per candle sequence
- NFR-002: All algorithms must be pure, deterministic functions without network side effects

## Acceptance Criteria
- ACC-001: BOS is confirmed if and only if close exceeds swing level plus ATR buffer
- ACC-002: CHOCH correctly flips trend and marks reversal only on protected swing violation
- ACC-003: Premium and Discount accurately computes 0.5 midpoint equilibrium and classification
- ACC-004: Zone records monotonically advance through states without resurrection
- ACC-005: Sweep events validate wick penetration and close back inside pool tolerance
- ACC-006: All unit and regression tests pass deterministically via npm test

## Edge Cases
- Insufficient candle history under 20 candles
- Flat zero-range candles where ATR is zero
- Massive gap candles breaking multiple structural levels simultaneously

## Dependencies
- Binance indicator utilities for wilderAtr
- Existing Market types
