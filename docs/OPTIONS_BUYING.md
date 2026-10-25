# Crypto options buying (long CE / PE only)

The cockpit trades futures and options together. `npm run dev:paper` (and `dev`, `dev:live`, `dev:alert`) starts the
futures fleet and, beside it, an options desk. The desk buys calls (CE) on an aligned uptrend and puts (PE) on an
aligned downtrend, on Binance Options contracts (`BTC-261030-81000-C`). It never sells an option to open. The most a
position can lose is the premium it paid plus fees.

| Command | Futures | Options (`OPTIONS_VENUE=auto`) |
| --- | --- | --- |
| `npm run dev:paper` | local paper engine | `local`: in-process options book, `data/options-state-local.json` |
| `npm run dev:paper` + `PAPER_EXCHANGE_URL` | paper_exchange account `PAPER_EXCHANGE_ACCOUNT_ID` | paper_exchange account `<PAPER_EXCHANGE_ACCOUNT_ID>-options` (`CRYPTO_OPTION`) |
| `npm run dev:live` / `dev:alert` | live Binance USD-M | `monitor`: signals and alerts only; no live options execution exists |
| any, `OPTIONS=off` | as above | off |

- **Separate wallet.** Options use their own wallet, like Binance's Options wallet. Futures margin and option premium
  never mix, and the perpetual broker path never sees an option position. Sharing the futures paper_exchange account
  is refused.
- **Shared controls.** The kill switch (`k`, or `data/kill-switch.json`) halts option entries too, and a futures
  drawdown halt halts them as well. Option exits keep running during a halt. The Ollama advisor and its key pool are
  shared with futures.
- **Independent timer.** The desk runs every `OPTIONS_LOOP_MS` (15 s) on its own timer. A slow option chain or a down
  options venue cannot stall the futures loop. A failed start (Binance unreachable, paper_exchange down) is logged once
  and retried every tick.
- **Cockpit view.** The POSITIONS column shows an `OPTIONS` block under the futures positions: venue, equity, any halt,
  and one line per underlying. Each option log line is prefixed `OPTIONS`.

**No CoinDCX execution.** `npm run dev:coindcx` no longer exists (removed in d9c7ce8), and CoinDCX live execution is
refused for futures (issue #31). For options, `@nemesis-oss/coindcx-sdk` 1.3.0 has no options endpoints, so
`OPTIONS_VENUE=coindcx` is refused and `coindcx_monitor` is an alias of `monitor`.

`npm run options:run` runs the same desk headless, without the TUI or the futures fleet.

## Components

| Concern | Source | Module |
| --- | --- | --- |
| Option chain, index, marks + IV, depth | binance-sdk 3.2.0 `client.options.market` (eapi), read-only client | `src/options/OptionChainService.ts` |
| Underlying direction | binance-sdk USD-M klines (15m/1h/4h, closed bars only) feeding the existing `MarketStateBuilder` | `src/options/UnderlyingContext.ts`, `DirectionEngine.ts` |
| Contract choice and entry economics | Black-Scholes greeks from the venue's own mark IV | `ContractSelector.ts`, `blackScholes.ts` |
| Sizing and governors | premium-at-risk sizing, daily loss and loss streak | `OptionRiskPlanner.ts` |
| Exits | premium stop, target, trailing stop, max hold, pre-expiry, thesis flip | `ExitPolicy.ts` |
| Lifecycle | finite state machine per underlying, persisted | `OptionPositionMachine.ts`, `OptionsBuyingEngine.ts`, `stateStore.ts` |
| AI | `OllamaAdvisor.vetoOption` (ollama-sdk): can block an entry, can never originate one or set a price | `src/ollama/advisor.ts` |
| Execution | `local`, `paper_exchange` (`CRYPTO_OPTION`), `monitor` | `venues.ts` |
| Cockpit wiring | started by the Orchestrator, rendered in the POSITIONS column | `OptionsDesk.ts`, `src/runtime/Orchestrator.ts`, `src/ui/accountPanels.ts` |

## State machine

```
IDLE --SIGNAL--> SIGNAL_DETECTED --SUBMIT--> ENTRY_PENDING --FILL--> POSITION_OPEN --EXIT_TRIGGER--> EXIT_PENDING --EXIT_FILL--> POSITION_CLOSED --RESET (cooldown)--> IDLE
                       |                          |                       |                     |  ^ PARTIAL_EXIT / EXIT_RETRY
                       +--REJECT--> IDLE          +--NO_FILL--> IDLE      +--EXTERNAL_CLOSE------+--+--> POSITION_CLOSED
IDLE --ADOPT--> POSITION_OPEN   (startup: a venue position nothing tracks)
```

Any other (state, event) pair throws `IllegalTransitionError`.

## Entry pipeline

Each step either passes or records why it refused (`ENTRY_REJECTED` in the journal).

1. **Gates.** Kill switch (`data/kill-switch.json`, shared with the cockpit), daily loss, loss streak, open-position cap.
2. **Direction.** Gives CE when the regime is `TREND_UP`, the HTF structure is `BULLISH`, 15m EMA20 > EMA50,
   ADX >= `OPTIONS_MIN_ADX` and 15m RSI <= `OPTIONS_RSI_MAX_LONG`. PE is the mirror case. Anything else gives no trade.
   This is a deterministic direction filter. It has **not** been backtested on option prices.
3. **Screen (marks only).** Keeps contracts on the chosen side that pass all of these checks:
   - DTE is between `OPTIONS_MIN_DTE_HOURS` and `OPTIONS_MAX_DTE_HOURS`.
   - The contract unit is in `OPTIONS_ALLOWED_UNITS`.
   - The venue sent a mark IV.
   - The venue's mark is within `OPTIONS_MODEL_TOLERANCE` of the Black-Scholes price at that IV.
   - |delta| is between `OPTIONS_MIN_DELTA` and `OPTIONS_MAX_DELTA`.

   Survivors are ranked by distance to `OPTIONS_TARGET_DELTA`.
4. **Economics (depth on the best `OPTIONS_DEPTH_CANDIDATES` only).** Refuses a contract when any of these holds:
   - the quote or index is stale;
   - the book is one-sided or crossed;
   - the spread is above `OPTIONS_MAX_SPREAD_PCT`;
   - IV/RV is above `OPTIONS_MAX_IV_RV`;
   - the edge ratio is below `OPTIONS_MIN_EDGE_RATIO`. The edge ratio is
     `(|delta| x move + gamma x move^2 / 2) / (spread + round-trip fees + theta over the horizon)`, with the move set
     to 1h ATR x sqrt(`OPTIONS_HOLD_HORIZON_HOURS`);
   - target/stop reward:risk is below `OPTIONS_MIN_REWARD_RISK`.

   The move is a heuristic used as a cost hurdle. It is not a forecast.
5. **Size.** The smallest of three caps, then what the book can fill within `OPTIONS_MAX_SLIPPAGE_PCT`, floored to the lot step:
   - risk: `equity x OPTIONS_RISK_PER_TRADE_PCT / (fill - stop + fees)`;
   - premium: `equity x OPTIONS_MAX_PREMIUM_PCT / (fill + fee)`;
   - portfolio: room left under `OPTIONS_MAX_TOTAL_PREMIUM_PCT`.

   The premium cap exists because a gap through the stop can lose the whole premium.
6. **LLM veto** (`OPTIONS_LLM_VETO`). Offline or a transport error proceeds. An unparseable or unknown reply vetoes.
7. **Re-quote.** Refuses if the ask has moved past the plan's limit. The engine then persists the order id
   (`ENTRY_PENDING`) and only then sends the order. If the reply is lost, the next cycle reconciles by that id and never resends.

## Exits

Evaluated every cycle on the executable **bid**:

| Exit | Rule |
| --- | --- |
| Stop | bid <= entry x (1 - `OPTIONS_STOP_PCT`) |
| Target | bid >= entry x (1 + `OPTIONS_TARGET_PCT`) |
| Trailing stop | once the peak bid reaches +`OPTIONS_TRAIL_ARM_PCT`, the stop ratchets to peak x (1 - `OPTIONS_TRAIL_PCT`) and never moves down |
| Thesis flip | the direction read turns to the opposite side |
| Time stop | open longer than `OPTIONS_MAX_HOLD_HOURS` |
| Pre-expiry | within `OPTIONS_EXIT_BEFORE_EXPIRY_HOURS` of the 08:00 UTC expiry |

- Time exits fire even without a fresh quote. Price exits wait for one (`STALE_QUOTE` is journaled).
- A failed or partial exit stays `EXIT_PENDING` and is retried every cycle, reusing the order id while its outcome is unknown.
- After `OPTIONS_MAX_EXIT_ATTEMPTS_BEFORE_ALERT` attempts the retry is logged as an error.
- A position that disappears from the venue is booked at the worst case (the whole premium), so the daily-loss
  governor can only overstate the loss.

## Venues

- **local**: in-process, persisted in the state file. Fills walk the real Binance book (VWAP, never past the limit,
  lot-floored), so thin books give real partial fills.
- **paper_exchange**: `instrument_type: CRYPTO_OPTION` on a dedicated USD/USDT account. The agent walks the Binance book
  and sends the walked size at its VWAP as `execution_price`, and pushes the underlying index and option marks to
  `/api/mark_prices`. The broker refuses option writing (a sell must be `reduce_only`), leverage other than 1, and buys
  from 08:00 UTC on expiry. It settles leftover positions at intrinsic value against the underlying mark.
- **monitor** (alias `coindcx_monitor`): journals `WOULD_BUY` and logs the alert; nothing is traded. This is the only
  options venue under `MODE=live`.
- **Binance live** is refused at startup. It needs the live guard set used for perpetuals (reconciliation from fills, a
  trade journal, protection) ported to eapi first.

## Fees

`min(OPTIONS_FEE_RATE x index x qty x unit, OPTIONS_FEE_CAP x premium x qty)`. The defaults (0.03% and 10%) are the
published Binance Options taker schedule. Pin them to your account's `GET /eapi/v1/commission`. paper_exchange charges
the same formula (`PAPER_EXCHANGE_CRYPTO_OPTION_FEE_RATE` / `_CAP`).

## Known limits (read before going further)

- **No edge is established.** Nothing here has been validated on historical option prices. The next step is a backtest
  on historical Binance option klines/marks (`/eapi/v1/klines`, `/eapi/v1/mark`), comparing CE-only, PE-only and both.
- **Contract units.** Only `unit = 1` contracts are traded by default. For other units, the premium-per-contract
  convention must be confirmed in the exchange UI before widening `OPTIONS_ALLOWED_UNITS`. The model-consistency
  screen refuses a contract whose mark does not reconcile with its own IV (the XRP-style mismatch).
- **Greeks** are computed with Black-Scholes from the venue's mark IV. The venue's own greek fields are not read,
  because their per-contract units are not documented.
- **Geo-restriction.** Binance returns HTTP 451 from restricted locations. The runner exits at its first request.
- **Expiry settlement** on paper_exchange uses the last pushed underlying mark. Binance uses an averaged index before
  expiry, so the agent's pre-expiry exit is the primary control and settlement is the fallback.
