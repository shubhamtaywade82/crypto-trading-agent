# Directional live gate

A conflict veto on futures entries, driven by a committed experiment. **Off by default. Nothing in the repo enables it.**

## Modes

| `DIRECTIONAL_GATE` | Effect on entries |
| --- | --- |
| `off` (default) | None. Nothing is read, computed or journaled |
| `shadow` | Records a directional verdict on each entry that reaches the order stage, and logs it. Blocks nothing |
| `enforce` | Blocks an entry only against a calibrated verdict for the OPPOSITE side. It cannot create an entry. If the directional data cannot be evaluated, it blocks (fail closed) |

Any other value is refused as `enforce`, so a typo blocks entries rather than disabling the gate.

## Where it runs

Entries only (`OPEN_*`). A check runs after the risk, advisor, TEV1 and execution-quality gates, and before the friction gate. Exits and `CLOSE` are never gated.

## Environment

| Variable | Required when on | Meaning |
| --- | --- | --- |
| `DIRECTIONAL_GATE` | - | `off`, `shadow` or `enforce` |
| `DIRECTIONAL_EXPERIMENT_DIR` | yes | Output folder of a committed experiment run: `config.json`, `manifest.json`, `results.json` |
| `DIRECTIONAL_MAX_STOP_PCT` | yes | Widest stop accepted, percent of entry. No default: it is a risk parameter |
| `DIRECTIONAL_MAX_BAR_AGE_MS` | no | Freshness limit for the last closed 5m bar. Default 900000 (15 min). Operational, not a trading parameter |

The bars are refreshed every 60 seconds (`DIRECTIONAL_REFRESH_MS`), 300 closed 5m klines per symbol, read-only.

## What enforce requires at startup

The gate refuses, and blocks entries with a logged reason, unless all of these hold:

- the experiment folder loads, and `config.json` matches the hash in `manifest.json`;
- the experiment is 5m and its criterion is `HOLDOUT_V1`;
- its manifest says `workingTreeClean: true` (a committed run);
- at least one cell is admitted and holdout-accepted.

Shadow runs with the same checks, except the clean tree and the calibrated cell. A shadow refusal turns the gate off and logs why.

## What a verdict needs

For one side, on the last closed bar: a rejection confirmed on that bar, an entry context at that bar, an admitted and holdout-accepted cell for that context, a stop no wider than `DIRECTIONAL_MAX_STOP_PCT`, and known room to the nearest live opposing zone. A verdict with no opposing zone is `ROOM_UNVERIFIED` and is NO_TRADE, so today a calibrated verdict can only come from a bar that has a known opposing zone.

## Journal

Each decision record gets an optional `directional` field while the gate is on: `mode`, `blocked`, `wouldBlock`, `reason`, and the LONG and SHORT verdicts. A blocked entry has status `DIRECTIONAL_REJECTED`. The dashboard's rejected filter and status list include it.

## Before enabling anything

1. Run an experiment on the committed code. The CLI now writes `config.json` beside the results. Results written before that commit cannot be loaded by the gate.
2. Enable `shadow` on paper. Read the `directional` field in the journal against what happened next. Shadow costs no trades.
3. Only then consider `enforce`. That is a trading decision, and it should be made by a person who has read the shadow data.

## Decisions I made that you should confirm

- Enforce is a conflict veto: it removes entries, it never adds one.
- Enforce blocks when data is unavailable. With bad bars, every entry is blocked. This is the same fail-closed rule as the friction gate.
- Room uses every live zone (`minZoneScore` 0). It is not yet part of the pre-registered config.
- The freshness limit and the 60-second refresh are operational values.

## Not verified here

- The live flow-kline call (`BinanceClient.getFlowKlines`). Its field positions follow the public kline layout, but no live response was read: Binance is unreachable from this environment.
- A running `npm run dev` with the gate on.
