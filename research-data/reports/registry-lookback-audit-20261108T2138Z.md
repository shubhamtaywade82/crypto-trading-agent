# Registry lookback audit - 2026-11-08T21:38Z

## Finding

A reproducibility conflict exists in the SOL Donchian records:

- The 2026-11-08T18:26Z context strategy report describes the 55-trade SOL result as a "15-bar Donchian" candidate.
- The main registry entry is `SOL-DONCHIAN20-BULL-LOW-V1-20261105T1825Z`, with strategy code `DONCHIAN_BREAKOUT_BULL_LOW_V1` and 55 OOS trades.
- The combined registry snapshot also contains `DONCHIAN20-CONTEXT-WF-V2` ("Context-aligned Donchian20 walk-forward") and a separate `DONCHIAN20-SOL-BULL_LOW` ("4h Donchian20 breakout") entry.
- The separate 12-trade `DONCHIAN20-SOL-BULL_LOW` candidate is OOS_PROMISING (+0.606 mean net R, PF 2.72) but remains far below the 100-trade per-cell gate.

These are not interchangeable candidates. The 55-trade result remains INSUFFICIENT_EVIDENCE; its exact lookback must not be inferred from the narrative report or identifier alone.

## Required remediation

1. Trace the frozen experiment spec, parameter artifact and backtest source for the 55-trade result.
2. Reconcile the actual Donchian lookback and strategy version across the spec, registry ID, report and artifact manifest.
3. Regenerate the report and registry metadata with one canonical identifier and recompute hashes.
4. Until this is done, do not reuse the 55-trade candidate as a fully reproducible baseline and do not change its evidence status.

Queue item: `RQ-036_REGISTRY_DONCHIAN_LOOKBACK_CONFLICT`.
No strategy status was changed by this audit.
