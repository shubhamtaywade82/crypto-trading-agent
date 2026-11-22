# FEATURE-003: Statistical Regime & Mean-Reversion Engine

## Overview
Comprehensive statistical regime filtering and mean-reversion engine for crypto assets. Implements multi-anchor deviation tracking (VWAP, SMA, Bollinger Bands, Z-score) with Bollinger + RSI extreme re-entry confirmation and strict regime conditioning (active in RANGE / LOW_VOL with low ADX, vetoed in strong trending regimes).

## Problem
Currently, mean-reversion calculations in the codebase are simplistic inline functions that calculate static deviations without statistical confirmation. Taking mean-reversion counter-trend trades during strong expansion trends leads to catastrophic losses ("catching falling knives"). Mean reversion must be strictly conditioned on market regime and require observable confirmation (e.g. RSI leaving extreme and re-entering the band).

## Scope
### In Scope
- Multi-anchor statistical mean tracking (SMA-20, VWAP, Bollinger Bands, rolling Z-score)
- Bollinger Band touch and RSI extreme re-entry confirmation logic (reverting back inside 30/70 bands)
- Regime-gated candidate qualification (active in RANGE / LOW_VOL regimes with ADX <= 20; vetoed in TREND_UP / TREND_DOWN)
- Pure functional MeanReversionEngine module in src/market/
- Backward-compatible enhancement of MeanReversionState in MarketState

### Out of Scope
- Multi-timeframe signal fusion matrix (deferred to FEATURE-004)
- Live order execution and exchange routing

## Actors
- StrategyEngine: Executes mean-reversion trades only when regime is favorable and confirmation triggers
- SetupEngine: Generates mean-reversion setup scenarios with entry, stop, and equilibrium target
- RiskEngine: Enforces tighter stop losses on mean-reversion setups due to adverse trend potential

## Functional Requirements
- REQ-001: System shall calculate deviation metrics against SMA, VWAP, and Bollinger Bands with rolling Z-score
- REQ-002: System shall detect Bollinger Band extreme touches followed by RSI re-entry confirmation
- REQ-003: System shall evaluate regime favorability (RANGE / LOW_VOL with ADX <= 20) and veto mean reversion in strong trends
- REQ-004: System shall classify mean-reversion candidates into BUY_CANDIDATE, SELL_CANDIDATE, or NONE
- REQ-005: System shall integrate enhanced mean-reversion metrics into MarketState

## Non-Functional Requirements
- NFR-001: Mean-reversion evaluation must complete in under 2ms per candle sequence
- NFR-002: All calculations must be pure, deterministic functions without network side effects

## Acceptance Criteria
- ACC-001: Z-score and percentage deviation are accurately computed across candle history
- ACC-002: Bollinger + RSI confirmation flags fire only when price touches the band and RSI crosses back inside
- ACC-003: Strong trending regimes (ADX > 25, TREND_UP/TREND_DOWN) strictly veto mean-reversion candidates
- ACC-004: Handles insufficient or flat candle history gracefully returning safe neutral states
- ACC-005: All unit and regression tests pass deterministically via npm test

## Edge Cases
- Insufficient candles under 20 bars
- Zero-variance candle sequences where standard deviation is zero
- Massive runaway trend spikes with extreme Z-scores that must be vetoed by regime filters

## Dependencies
- Binance indicator utilities (bollinger, rsi, zscore, lastVwap)
- Existing Market types (MeanReversionState, RegimeSnapshot)
