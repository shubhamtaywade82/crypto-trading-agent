# Liquidity rejection zones

A deterministic, replayable market-structure subsystem. It finds price levels where a sweep was **rejected** (taken out and reclaimed), measures how strong that rejection was from candle and trade-flow evidence, and keeps the resulting zones through a lifecycle across timeframes.

It publishes facts only. Nothing here sends orders, changes a strategy, or reads a live feed. Its output is a snapshot a strategy may consume later.

Code: `src/market/rejection/`. Replay: `npm run zones:replay`. Tests: `tests/rejection*.test.ts`.

## How it differs from existing market-structure code

| Existing | What it is | This subsystem |
| --- | --- | --- |
| `market/ZoneLedger.ts` | Cause zones: the origin candle of a structure break, tracked through FRESH / TESTED / MITIGATED / INVALIDATED / EXPIRED | Zones born from a **rejection** (a sweep that reclaimed a reference level), with clustering and a strength score |
| `microstructure/LiquidityEvents.ts` | Order-book events on displayed walls (`ABSORB`, `PULLED`, …) | Candle and taker-volume evidence per bar on any timeframe. It does not need the book |
| `market/LiquidityEngine.ts`, `SweepLedger.ts` | Liquidity pools and sweeps from swing points | The sweep reference is the rolling low or high of the last N bars. Reclaim, wick, volume and follow-through are required |

## Pipeline

```
raw 1m klines (Binance USD-M, taker-buy fields)
   │  ingestMinutes          validate · collapse identical duplicates · exclude conflicting duplicates · report gaps
   ▼
canonical 1m bars  (complete only)
   │  aggregateMinutes       5m · 15m · 1h · 4h  (a bar is complete only with every aligned 1m present)
   ▼
per-timeframe bars
   │  computeFeatures        wick ratios · close location · volume delta · relative volume · Wilder ATR   (causal)
   │  detectRejections       sweep → reclaim → wick → relative volume → follow-through   (CONFIRMED | FAILED | CANDIDATE)
   │  buildRejectionZones    clustering · lifecycle · strength
   ▼
RejectionSnapshot          events · zones · confluence bands · ingestion report
```

`buildRejectionSnapshot(symbol, minutes, options)` runs the whole pipeline. It reads no clock and has no I/O, so a historical run and a live run over the same klines produce the same JSON.

## Rules

### Detection (per timeframe, bar *i*)

Bullish (DEMAND) requires all of:

1. Bar *i* is complete, and its features and ATR are defined.
2. Relative volume ≥ `minRelativeVolume` (quote volume ÷ median of the prior `volumeWindow` complete bars; the bar is never in its own baseline).
3. The lookback bars *i−L … i* are complete and contiguous.
4. **Sweep:** `low < min(low over prior L bars)`.
5. **Reclaim:** `close > that reference level`.
6. Lower wick ratio ≥ `minWickRatio`.

Then the outcome is resolved from bars *i+1 … i+confirmBars*:

| Outcome | Condition | Known at |
| --- | --- | --- |
| CONFIRMED | Displacement from the reclaim close, `max(high) − close_i`, reaches `minReversalAtr × ATR_i` | close of the confirming bar |
| FAILED `RECLAIM_LOST` | A close below the reference level (before confirmation) | close of that bar |
| FAILED `INCOMPLETE_WINDOW` | A missing or incomplete bar in the window | close of that bar |
| FAILED `NO_FOLLOW_THROUGH` | Window ends without the displacement | close of the last window bar |
| CANDIDATE | Data ends before the window does | none. Never assumed |

SUPPLY mirrors every rule. Same-direction candidates are suppressed for `confirmBars` bars after one starts, so a multi-bar rejection yields one event.

`kind` is `ABSORPTION_LIKE` when the sweep bar's flow opposed the move (sell-led at a DEMAND, buy-led at a SUPPLY) and price still reclaimed. Otherwise it is `REJECTION`.

### Zone construction

- Zone interval: DEMAND `[sweep low, reference level]`; SUPPLY `[reference level, sweep high]`.
- Only CONFIRMED events create or reinforce zones.
- A confirmed event merges into a live zone of the same direction when the gap between their intervals is ≤ `clusterAtrFraction × ATR`, and the merged width is ≤ `maxZoneWidthAtr × ATR`. The closest qualifying zone wins; ties go to the earliest.
- BROKEN and EXPIRED zones never absorb evidence. A new rejection at that level starts a new zone.

### Lifecycle

Within bar *j*, existing zones advance first, and then events confirmed by bar *j* are integrated. A rejection therefore cannot test its own zone.

| Transition | Rule |
| --- | --- |
| ACTIVE → TESTED | First entry: the bar's range touches the zone while the previous bar did not. Each entry is one test |
| TESTED / ACTIVE / RECLAIMED → WEAKENING | Test count reaches `weakeningTests` |
| any → BROKEN | Close beyond the far boundary (DEMAND: below the low; SUPPLY: above the high). Takes precedence over a test on the same bar |
| BROKEN → RECLAIMED | Next close back on the original side |
| any non-terminal → EXPIRED | `maxAgeBars` after creation, regardless of state |

Every transition is recorded with its known-at time. Lifecycle stamps never move once written.

### Strength

`score = 100 × clamp01(0.25·R + 0.20·V + 0.15·D + 0.15·S + 0.25·C − 0.50·W)`

| Component | Definition | Saturates at |
| --- | --- | --- |
| R reversal | mean displacement in ATR ÷ 2 | 2 ATR |
| V volume | mean relative volume ÷ 3 | 3× |
| D delta | mean \|delta ratio\| (flow intensity; its sign is in `kind`) | 1 |
| S speed | mean of `1 − (bars − 1) / confirmBars` | next bar = 1 |
| C confluence | `(rejectionCount − 1) / 3` | 4 rejections |
| W weakness | `(tests − 1) / 3`, and 1 once BROKEN | 4 tests |

The weights are the design note's starting hypotheses. They are not validated. Components are returned next to the score.

### Confluence

`findZoneConfluence` returns bands where live zones from **two or more timeframes** overlap in one direction, with the timeframes listed. It does not add them into the score. The timeframes are built from the same candles, so counting them as independent evidence would overstate the case.

## Parameters

| Option | Default | Meaning |
| --- | --- | --- |
| `atrPeriod` | 14 | Wilder ATR period |
| `volumeWindow` / `minVolumeHistory` | 20 / 10 | Relative-volume baseline |
| `lookbackBars` | 20 | Reference-level window |
| `minRelativeVolume` | 1.5 | Sweep bar volume floor |
| `minWickRatio` | 0.45 | Sweep bar wick floor |
| `confirmBars` | 3 | Follow-through window, and the cooldown length |
| `minReversalAtr` | 0.5 | Displacement required |
| `clusterAtrFraction` | 0.5 | Merge distance |
| `maxZoneWidthAtr` | 3 | Largest merged band |
| `weakeningTests` | 2 | Tests before WEAKENING |
| `maxAgeBars` | 1m 720 · 5m 288 · 15m 192 · 1h 168 · 4h 120 | Expiry budget, in bars of that timeframe |

Invalid values throw. Examples: `volumeWindow: 0` would otherwise make `slice(-0)` return the whole history as the baseline.

## Invariants

- **No lookahead.** Every feature at index *i* depends only on bars ≤ *i*. Every outcome is stamped with the known-at time of the bar that resolved it. Tests check both properties directly.
- **Prefix stability.** For any cutoff, every event that was resolved by the cutoff, and every zone transition stamped at or before it, is identical whether the run stopped there or continued (property tests on a seeded random walk).
- **Fail closed on data.** Conflicting duplicate minutes exclude the minute and count as a gap. Gaps are never filled. A missing or incomplete bar blocks any detection whose lookback or window it touches. ATR restarts after a gap, so no feature bridges one.
- **Incomplete higher-timeframe bars are kept but marked, never used.** The still-forming final bucket is dropped.

## Deviations from the design note

1. **States.** CANDIDATE and CONFIRMED are event states. Zones start ACTIVE, because a zone exists only after its rejection is confirmed. A zone-level CONFIRMED state would last zero bars.
2. **Breaks.** BROKEN is entered on a single close beyond the boundary, and RECLAIMED on a single close back. The note's "accepted beyond" is not modelled as multi-bar acceptance. That is a candidate for validation.
3. **Speed.** Confirmation is measured as displacement from the reclaim close, not from the sweep low. Otherwise the sweep wick would count twice.
4. **Cooldown.** Added so overlapping windows produce one event per rejection.
5. **Phase 4 is not built:** no `aggTrade` stream, no order-book evidence, no chart overlay.

## Not yet done

- **Not wired** into `MarketState`, the strategies, or the order path. It is a standalone, read-only module.
- **Batch, not incremental.** `buildRejectionSnapshot` recomputes from the 1m series. It is deterministic and correct, but for live use it needs an append-only incremental form. The prefix-stability tests are the spec for that work.
- **Thresholds are unvalidated.** The design note's section 11 questions have not been tested. That requires long, contiguous 1m history, chronological out-of-sample splits, and realistic costs. The repo's `research-data/` holds only short native 5m/15m/1h samples: at most 16 bars per 5m series, which is too short to produce events.

## Running it

```bash
npm run zones:replay                                              # recorded native klines under research-data/
npm run zones:replay -- --dir <dir-of-jsonl> --symbol SOLUSDT --json out.json
npx tsx --test tests/rejection*.test.ts                           # 56 tests
```

Each JSONL line is a closed kline: `{symbol, interval, openTime, open, high, low, close, volume, quoteVolume, trades, takerBuyBase}`, the same fields the recorded files use.
