# Liquidity view (order book and tape, without a ladder)

`Tab` cycles the cockpit views: **cockpit → MTF → LIQUIDITY**. In the liquidity view:

- `↑` / `↓` select the symbol;
- `w` cycles the field span (2m / **5m** / 30m / 2h);
- `d` toggles the raw ladder, kept only as a diagnostic drill-down.

The view shows what the order book and the tape are *doing*. You don't have to rebuild that state from 100 price levels.

![Liquidity view, simulated SOLUSDT data](images/liquidity-view-simulated.png)

*The screenshot uses simulated data: price drifts into a 101.40 bid wall, sellers hit it and it holds (ABSORB), then
buyers lift price and the micro bias confirms LONG. The 5m column still shows the earlier selling into the wall. It is
not live market data.*

## Time horizons

Data is processed at stream cadence, while every opinion has its own, slower horizon:

| Layer | Horizon | Updates |
| --- | --- | --- |
| Book, spread, friction | live (100 ms depth diffs) | the entry gate reads it at order time; the screen samples it once a second |
| Order flow | rolling 5s · 30s · 2m · 5m, side by side | every second; a window longer than the unbroken live stretch is marked `*` |
| Pressure field | 2m / 5m / 30m / 2h (`w`) | 1 s columns (kept 5 m), 10 s columns (30 m), 60 s columns (2 h). Wider columns hold the time-averaged depth, so the shade shows persistence |
| Micro bias | persisted state | changes only by its confirmation rules (below) |
| Context | 15m / 1h / 4h closed candles | from the MarketState; never from the forming candle |

Risk is not delayed by any of this. The friction gate and the book-integrity checks act on the live book, and a book
that stops being live clears the bias at once.

## What each panel answers

| Panel | Question | Built from |
| --- | --- | --- |
| **Liquidity pressure field** (left) | Where is liquidity, and is price moving through it? | Time × price grid, one column per second. **Background:** displayed depth, green for bids and red for asks, on a log scale from the window's median to its 99th percentile, so walls stand out at any liquidity regime. **Overlays:** `━` is the mid path; `●`/`•` are executed aggressor volume (green buy, red sell); `·` is a cell never measured. |
| **Order flow** (table) | What are aggressors doing to price, now and over the backdrop? | One column per window (5s / 30s / 2m / 5m). **Trade Δ:** signed aggressor notional. **OFI/depth:** top-of-book order-flow imbalance (Cont–Kukanov–Stoikov), which counts limit adds and cancels, normalized by the average touch depth. **Price:** mid change in bp. **Phase:** `BUY↑` initiative buying, `BUY=` buying absorbed, `SELL↓`, `SELL=`, drift, balanced, thin. The price-move threshold scales with √window. A 5s burst against a 2m/5m backdrop reads as exactly that. |
| **Displayed depth** | How is resting size skewed? | Bid/ask quantity imbalance within ±10 and ±25 bps. It is labelled cancellable, because displayed depth costs nothing to pull. |
| **Aggressor flow** | Who is crossing the spread? | 30 s buy/sell notional and a CVD sparkline. |
| **Execution friction** | Can the planned size trade at an acceptable cost now? | Spread, plus depth-walked slippage for `MICRO_ORDER_NOTIONAL` on each side. OK / ELEVATED / BLOCK against `MICRO_MAX_SPREAD_BPS` and `MICRO_MAX_SLIP_BPS`. A book that is not live is always BLOCK. |
| **Liquidity events** | What happened to the walls? | `WALL`: a concentration that persisted for at least 3 s, so flicker is filtered out. `ABSORB`: aggressors traded at least the wall's size into it, the wall held at 70% or more of its peak, and price stayed on its side. `EATEN`: it shrank with matching executed volume, optionally with "price through". `PULLED`: it shrank without trades, i.e. it was cancelled. |
| **Micro bias** | What does the microstructure persistently support? | LONG / SHORT / NEUTRAL, how long it has been held, any pending change with its progress (`→ LONG 6/10s`), this second's raw evidence, and the closed-candle context with a conflict flag (`1h opposes bias`). Rules below. **Not a probability and not wired to orders.** |

## Micro bias rules (persistence and hysteresis)

| Change | Needs |
| --- | --- |
| NEUTRAL → LONG | 30 s window shows initiative buying, or selling absorbed at a bid wall, **and** the 2 m trade delta ≥ +0.10. Must hold continuously for **10 s**; any gap restarts the clock. |
| LONG held | Only the looser rule: 2 m delta > −0.10 and no initiative selling on 30 s. |
| LONG → NEUTRAL | The hold rule failing continuously for **30 s**. |
| LONG → SHORT | The SHORT entry rule holding continuously for 10 s. |
| Any → NEUTRAL immediately | The book is not live (syncing, resync, stale). |

SHORT mirrors LONG. Entry is stricter than hold, so the state does not flicker when one metric crosses zero. These
thresholds are starting points. Record readings and test them before giving the bias any role in trading.

## Data integrity

- Streams come through binance-sdk on USD-M: `<sym>@depth@100ms` and `<sym>@aggTrade`. The REST snapshot is
  `/fapi/v1/depth?limit=1000`.
- The local book follows Binance's procedure:
  1. Buffer diffs.
  2. Take the snapshot.
  3. Drop diffs with `u < lastUpdateId`.
  4. The first applied diff must straddle the snapshot.
  5. Every later diff must have `pu` equal to the previous `u`.
  6. A quantity of 0 removes the level.
- These all force a rebuild from a fresh snapshot: a sequence gap, a crossed book, a malformed level, or a stream
  reconnect.
- While a rebuild is in progress the view says `BOOK SYNCING` / `RESYNC` / `STALE` (no diff for 5 s). It withholds the
  field, and evidence reads INVALID. Nothing is interpolated.
- Cells beyond the snapshot range, or outside the band tracked at that moment, render as `·` (unknown), never as empty
  liquidity.
- Terminals without truecolor get a density ramp (`░▒▓█`) instead of background shading.

## Execution-friction entry gate

`MICRO_ENTRY_GATE` (default `on`) wires the friction verdict into futures entries. It is the last check before an
order is sent, after risk, the LLM veto and the execution-quality check.

- **What it measures.** Each `OPEN_*` entry is graded on the live local book for **its own side and size**. A long walks
  the asks for its notional, a short walks the bids. The grade covers:
  - the spread against `MICRO_MAX_SPREAD_BPS`;
  - the depth-walked VWAP slippage from mid against `MICRO_MAX_SLIP_BPS`.
- **Outcomes.**
  - `on`: a `BLOCK` verdict refuses the entry. It is journaled as `FRICTION_REJECTED` with the reason and the measured
    spread/slippage, and logged as `FRICTION BLOCK SOLUSDT sell $5000: sell slippage 13.0bps > 10`.
  - `ELEVATED` (above half a limit) passes.
  - `shadow`: blocks are only logged (`FRICTION (shadow) would block …`).
  - `off`: nothing is measured.
- **Fails closed.** With the gate on, these all refuse entries with that reason:
  - a book that is syncing, resyncing or stale (no diff for 5 s);
  - a missing feed, or a symbol with no book;
  - an order the known book cannot fill.

  A refused feed configuration leaves the gate on with no feed, so entries stop rather than trade unchecked.
- **Never gates exits.** `CLOSE` and every protective exit skip the gate.
- **Recorded on every entry.** Executed entries carry the measured friction in `execution.friction` of the decision
  journal, so the gate's thresholds can be reviewed against real fills.
- **Cannot be on without the feed.** `MICRO_ENTRY_GATE=on` (or `shadow`) with `MICROSTRUCTURE=off` is refused at
  startup.
- **Options are out of scope.** Option entries are not routed through this gate; they have their own spread and
  book-walk checks on the option book.

## Validating the directional features

1. **Record.** `MICRO_RECORD=on` appends one reading per symbol per second to
   `data/microstructure/<date>/<SYMBOL>.jsonl`. Each reading carries every window, OFI, phase, evidence, bias,
   friction and the events emitted that second. Recording runs inside the cockpit (`npm run dev:paper`); leave it on
   for days, not hours.
2. **Evaluate** with `npm run micro:eval`, which writes `REPORT.md` and `results.json` to
   `data/micro-eval/<timestamp>/`:

   ```bash
   npm run micro:eval                                     # everything recorded
   npm run micro:eval -- --from 2026-10-26 --to 2026-11-02 --symbols SOLUSDT,ETHUSDT
   npm run micro:eval -- --horizons 5,30,60 --fee-bps 5 --stride 30 --holdout 0.3
   ```

### What the evaluator does

| Step | Rule |
| --- | --- |
| Integrity | Per symbol: lines, malformed, duplicate and out-of-order readings, share LIVE, status counts, live segments, gaps over 3 s, the longest gap. A gap or a non-live book ends a segment. |
| Labels | Each LIVE reading gets the mid move to the first reading at or after t + horizon (1 s / 5 s / 30 s / 60 s by default). The forward reading must be at most 1.5 s late and in the same live segment, otherwise there is no label. |
| Costs | Round trip from mid: the recorded buy plus sell slippage for `MICRO_ORDER_NOTIONAL` (spread if slippage is missing), plus 2 × `--fee-bps` (default 4). The gross mean is shown next to the net, so "a real move that costs eat" is visible. |
| Directions | Fixed in code before any outcome is seen. **LONG:** bias LONG, evidence SUPPORTS_LONG, per-window phase INITIATIVE_BUYING or SELL_ABSORBED, OFI top quintile. **SHORT:** the mirrors, OFI bottom quintile. Everything else (NEUTRAL, balanced, drift, thin, middle OFI quintiles) is an undirected baseline, never a test. Bias onsets (the first second after a change) are tested separately, as the least overlapping observations. |
| Splits | Chronological. The last `--holdout` share of the time range (default 30%) is the holdout. OFI quintile cuts and volatility-regime terciles come from training only. |
| Inference | Cluster bootstrap of the net mean, with clusters of symbol × 15-minute block (`--block-min`), because one-second readings overlap. `--stride N` keeps one reading per N seconds (plus onsets) for a non-overlapping check. |
| Verdict | **PASS:** train 90% CI above 0 **and** holdout CI above 0 **and** holdout significance after Holm correction across every tested directional cell. **INSUFFICIENT:** fewer than 30 readings or 5 clusters in either split. **FAIL:** everything else. |
| Regimes | The holdout is split by realized-volatility tercile (5-minute look-back) for PASS cells, or for the best five holdout means when nothing passes. |
| Costs by status | p50 / p90 / p99 round-trip cost per friction status: the data for tuning `MICRO_MAX_SPREAD_BPS` / `MICRO_MAX_SLIP_BPS`. |

### Reading the result

- **PASS** makes a condition a candidate for a pre-registered forward test on new recordings. It is not a trading rule.
- **Each re-run spends the holdout.** Tuning thresholds and re-running on the same holdout uses it up, so evaluate
  changed rules on later recordings.
- **Scale.** One day of 4 symbols (about 350k readings) evaluates in about 30 s. Use `--from/--to` or `--symbols` to
  keep multi-week runs within memory.

Until a condition passes on fresh data, the phase, imbalance, evidence and bias stay display and recording only. Only
the execution-friction verdict gates anything (above), because it measures cost, not direction.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `MICROSTRUCTURE` | `on` | `off` stops the feed; the view says so. |
| `MICRO_BUCKET_BPS` | `1` | Field row height in bps of price (rounded to a clean step). |
| `MICRO_ORDER_NOTIONAL` | `5000` | Size the friction estimate walks the book for (USDT). |
| `MICRO_MAX_SPREAD_BPS` | `5` | Spread above which friction is BLOCK (ELEVATED above half). |
| `MICRO_MAX_SLIP_BPS` | `10` | Slippage above which friction is BLOCK (ELEVATED above half). |
| `MICRO_SAMPLE_MS` | `1000` | Sampling cadence (one field column per sample). |
| `MICRO_RECORD` / `MICRO_RECORD_DIR` | `off` / `data/microstructure` | Reading recorder. |
| `MICRO_ENTRY_GATE` | `on` | `on` refuses entries the book cannot absorb (fails closed), `shadow` only logs, `off` disables. |

Recorded readings (`MICRO_RECORD=on`) now include every window and the bias state, so the multi-window rules can be
tested offline against what followed.
