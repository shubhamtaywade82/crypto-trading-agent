# Backtest and Conditional-Edge Harness Audit — 2026-11-07 18:26 UTC

Repository source commit inspected: `13e2961e23f6d0a7ff9251b50b3e66716e93d705`. This is a remote source audit only; there is no local checkout and no test was executed.

## Findings

| Area | Observed source behavior | Required correction |
|---|---|---|
| Runtime | package.json requires Node >=24 and npm >=11; current runtime is Node 22.16.0/npm 10.9.2 | Provision compatible runtime |
| Backtest CLI timeframes | scripts/backtest.ts declares 15m, 1h, 4h; 5m omitted | Add 5m and verify feature alignment |
| Candle contract | src/types.ts Candle omits closeTime | Preserve openTime and closeTime through every fetch/archive path |
| Forming candles | backtest CLI maps raw kline rows without checking closeTime | Exclude rows unless closeTime < asOf before any signal/feature calculation |
| Request bounds | direct fetchKlines uses fetch(url) without explicit timeout | Add bounded timeout, retry/backoff and endpoint-status logging |
| Archive volume validation | validateCandles rejects volume < 0; volume = 0 is accepted | Require volume > 0 for research rows |
| Conditional-edge input | scripts/conditional-edge.ts loads DecisionRecord journals with outcomes | It is an outcome-analysis stage, not a raw-OHLCV strategy generator |
| Conditional-edge defaults | minN defaults to 30; bootstrap confidence defaults to 0.90 | Set predeclared confidence and sample gates explicitly |
| Walk-forward selection | CLI omits requireSignificant; walkForward defaults to raw ciLow > 0 selection | Require Holm-significant training cells before selection |
| Embargo/purging | walkForward supports embargoDays but CLI does not expose it; no explicit overlapping-label purge is wired by this CLI | Add embargo/purge policy and fixture tests |
| Serial dependence | Bootstrap clusters trades by UTC day | Validate dependence across adjacent days; use moving/stationary block bootstrap or justify day-cluster approximation |
| OOS gate | script prints aggregate selected OOS result; no >=100 OOS trades per symbol/context promotion gate | Add per-symbol/context OOS counts, CI, net costs and status enforcement |

## Consequence

The presence of scripts/backtest.ts and scripts/conditional-edge.ts does not establish a runnable, validated research pipeline. The first can produce a replay, but its current CLI data contract risks including a forming candle and cannot cover the required 5m timeframe. The second analyzes already-created decision outcomes and its default selection/evidence gates are weaker than the required conditional-registry policy.

## Smoke-test plan (not executed)

1. Create a tiny fixture with known OHLCV, closeTime, one forming row, one zero-volume row and one missing interval.
2. Assert forming row exclusion, zero-volume rejection, interval continuity, deterministic EMA/ATR outputs and identical repeat-run output.
3. Inject a future candle and assert earlier features/signals do not change (no-lookahead).
4. Run the replay twice with a fixed seed and compare decisions, trades, equity curve and metrics.
5. Run conditional-edge with >=100 OOS observations per symbol/context, 95% interval, Holm-significant training selection, purging/embargo and block-bootstrap uncertainty.
6. Read back all metrics and artifacts; only then permit an experiment status transition.
