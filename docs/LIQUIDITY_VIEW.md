# Liquidity view (order book and tape, without a ladder)

`Tab` cycles the cockpit views: **cockpit → MTF → LIQUIDITY**. In the liquidity view:

- `↑` / `↓` select the symbol;
- `d` toggles the raw ladder, kept only as a diagnostic drill-down.

The view shows what the order book and the tape are *doing*. You don't have to rebuild that state from 100 price levels.

![Liquidity view, simulated SOLUSDT data](images/liquidity-view-simulated.png)

*The screenshot uses simulated data: price drifts into a 101.40 bid wall, sellers hit it and it holds (ABSORB), then
buyers lift price. It is not live market data.*

## What each panel answers

| Panel | Question | Built from |
| --- | --- | --- |
| **Liquidity pressure field** (left) | Where is liquidity, and is price moving through it? | Time × price grid, one column per second. **Background:** displayed depth, green for bids and red for asks, on a log scale from the window's median to its 99th percentile, so walls stand out at any liquidity regime. **Overlays:** `━` is the mid path; `●`/`•` are executed aggressor volume (green buy, red sell); `·` is a cell never measured. |
| **Order-flow phase** | What are aggressors doing to price? | 30 s signed notional delta vs 30 s mid change. The four quadrants are initiative buying, buying absorbed, initiative selling and selling absorbed. Drift, balanced and thin are reported in words. |
| **Displayed depth** | How is resting size skewed? | Bid/ask quantity imbalance within ±10 and ±25 bps. It is labelled cancellable, because displayed depth costs nothing to pull. |
| **Aggressor flow** | Who is crossing the spread? | 30 s buy/sell notional and a CVD sparkline. |
| **Execution friction** | Can the planned size trade at an acceptable cost now? | Spread, plus depth-walked slippage for `MICRO_ORDER_NOTIONAL` on each side. OK / ELEVATED / BLOCK against `MICRO_MAX_SPREAD_BPS` and `MICRO_MAX_SLIP_BPS`. A book that is not live is always BLOCK. |
| **Liquidity events** | What happened to the walls? | `WALL`: a concentration that persisted for at least 3 s, so flicker is filtered out. `ABSORB`: aggressors traded at least the wall's size into it, the wall held at 70% or more of its peak, and price stayed on its side. `EATEN`: it shrank with matching executed volume, optionally with "price through". `PULLED`: it shrank without trades, i.e. it was cancelled. |
| **Micro evidence** | Do these line up? | SUPPORTS LONG / SUPPORTS SHORT / MIXED / NONE / INVALID. A case needs flow or absorption; depth imbalance can support a case but never make one. It is **evidence only**: not a probability, and **not wired to orders**. |

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

`MICRO_RECORD=on` appends one reading per symbol per second to `data/microstructure/<date>/<SYMBOL>.jsonl`. Each reading
contains the phase, imbalance, flow, friction, evidence and events emitted that second. Outcomes (the mid N seconds
later) can be joined offline, then tested over 1 s / 5 s / 30 s / 1 m horizons, after fees and slippage, per volatility
regime. Until that shows value, the phase, imbalance and evidence are display and recording only. Only the
execution-friction verdict gates anything (above), because it measures cost, not direction.

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
