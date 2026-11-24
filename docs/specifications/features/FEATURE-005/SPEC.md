# FEATURE-005: Market Intelligence & Foundational Quant Analytics (Milestone A)

## Overview
Foundational quantitative analytics engine and Market Terminal workbench for QuantLab. Provides reusable, pure mathematical primitives for returns calculations, rolling multi-estimator volatility, cross-asset correlation matrices, and Geometric Brownian Motion (GBM) Monte Carlo path simulations, integrated into a real-time Market Terminal workbench.

## Problem
Currently, performance metrics, volatility estimations, and stochastic simulations are scattered across disparate scripts and backtesting modules with inconsistent conventions, lack of standardized statistical estimators (e.g. Parkinson, Garman-Klass, Yang-Zhang), and without an integrated terminal visualization for real-time and historical multi-asset analysis.

## Scope
### In Scope
- Canonical returns calculator: simple returns, log returns, cumulative returns, rolling CAGR, annualized Sharpe ratio, and Sortino ratio (Project #2).
- Multi-estimator volatility engine: sample standard deviation, Parkinson (high-low), Garman-Klass (OHLC), and Yang-Zhang (drift-independent overnight jump) estimators (Project #2).
- Cross-asset dependency engine: Pearson correlation matrix, Spearman rank correlation, and covariance matrix across multi-asset returns (Project #8).
- Monte Carlo price path simulator: Geometric Brownian Motion (GBM) with drift and volatility, antithetic variate variance reduction, seedable deterministic PRNG, and quantile confidence bands (5th, 50th, 95th percentiles) (Project #1).
- QuantLab Market Terminal backend API route (`/api/quant/terminal`) and workbench panel (`QuantTerminalPanel.tsx`) in `apps/dashboard` (Project #10).
- Pure, zero-dependency functions adhering strictly to KISS/YAGNI and code quality limits (functions <= 30 lines, files <= 300 lines).

### Out of Scope
- Event-driven backtesting execution engine (deferred to FEATURE-006 / Milestone B).
- Options pricing and Black-Scholes surface (deferred to FEATURE-008 / Milestone D).
- Live exchange order execution or routing (retains strict PaperExchange boundary).

## Actors
- ResearchDesk: Consumes quantitative analytics for feature engineering and statistical validation.
- QuantDashboard: Visualizes returns, volatility, correlation heatmaps, and Monte Carlo projections.
- StrategyEngine: Uses canonical volatility and returns primitives for signal generation and sizing.

## Functional Requirements
- REQ-001: System shall compute simple, logarithmic, and cumulative returns series from price inputs.
- REQ-002: System shall compute annualized Sharpe and Sortino ratios with configurable risk-free rate and periods per year.
- REQ-003: System shall calculate rolling volatility using sample standard deviation, Parkinson, Garman-Klass, and Yang-Zhang estimators from OHLC data.
- REQ-004: System shall calculate pairwise Pearson and Spearman correlation matrices and covariance matrices across arbitrary asset return series.
- REQ-005: System shall generate Monte Carlo price paths under Geometric Brownian Motion with configurable drift, volatility, time steps, simulations count, and random seed.
- REQ-006: System shall expose `/api/quant/terminal` and provide an interactive terminal panel in `apps/dashboard/web`.

## Non-Functional Requirements
- NFR-001: All mathematical routines in `src/quant/` must be pure, synchronous, deterministic functions without network side effects.
- NFR-002: Monte Carlo simulation of 1,000 paths over 100 steps must complete in under 50ms.
- NFR-003: Functions must not exceed 30 lines and files must not exceed 300 lines per project standards.

## Acceptance Criteria
- ACC-001: Returns and volatility calculations match exact mathematical reference cases within 1e-9 tolerance.
- ACC-002: Parkinson, Garman-Klass, and Yang-Zhang estimators produce expected values on known geometric price sequences.
- ACC-003: Correlation matrix is symmetric with diagonal elements equal to 1.0 and off-diagonal bounded in [-1.0, 1.0].
- ACC-004: Monte Carlo GBM terminal price distribution converges to theoretical log-normal mean within 2% standard error.
- ACC-005: Terminal dashboard API returns valid JSON payload and UI renders without errors.
- ACC-006: All automated unit tests, typechecks, and builds pass cleanly via `kit verify`.

## Edge Cases
- Empty or single-element price arrays returning empty or zero series without throwing.
- Constant prices with zero variance and zero volatility without division-by-zero or NaN outputs.
- Negative prices or inverted high/low candle defects handled gracefully with input validation.

## Dependencies
- Existing `apps/dashboard` React + Vite + Express application.
- Node.js test runner (`tsx --test`).
