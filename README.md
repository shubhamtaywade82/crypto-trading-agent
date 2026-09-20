# crypto-trading-agent

A TypeScript agent for Binance USD-M perpetual futures. Multi-strategy signal
generation, risk gating, an optional Ollama LLM veto layer, and a TUI cockpit
built on Ink. Routes orders to either a local in-memory paper engine, a remote
`paper_exchange` Rails broker (over HTTP), or live Binance.

---

## Modes

| `MODE` | Backend | SL/TP enforcement | Per-strategy attribution |
|---|---|---|---|
| `paper` (default, no `PAPER_EXCHANGE_URL`) | Local in-memory `PaperEngine` | Local — `markAll` checks every tick | Yes (positions keyed by `symbol+strategy`) |
| `paper` + `PAPER_EXCHANGE_URL` | Remote `paper_exchange` Rails broker | Server-side — SL/TP submitted as `stop_loss`/`bounded` orders (issue #1) | No — broker positions are per-symbol, not per-strategy (issue #3 on broker side) |
| `live` | Live Binance | Exchange-side STOP_MARKET / TAKE_PROFIT_MARKET | No — Binance positions are per-symbol |

---

## Quick start

```bash
git clone https://github.com/shubhamtaywade82/crypto-trading-agent.git
cd crypto-trading-agent
cp .env.example .env   # then edit .env for your risk limits
npm install
npm run build
npm start
```

The cockpit needs at least 120×40 terminal cells. Use `?` inside the cockpit
for the command cheatsheet.

---

## Configuration

All configuration is via environment variables (validated with `zod` in
`src/config.ts`). The defaults shown below are the schema defaults, NOT
necessarily what's in `.env.example` — they were inconsistent before issue #9
was fixed.

| Variable | Default | Purpose |
|---|---|---|
| `MODE` | `paper` | `paper` or `live` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | (empty) | Required for `MODE=live` |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama daemon URL |
| `OLLAMA_MODEL` | `llama3.1:8b` | Model used for veto/advise/ask |
| `MIN_LEVERAGE` | `5` | Floor for the dynamic-leverage calculation |
| `MAX_LEVERAGE` | `10` | Ceiling for the dynamic-leverage calculation |
| `MAX_EXPOSURE_PCT` | `80` | Cap on notional as a % of equity |
| `RISK_PER_TRADE_PCT` | `1` | Risk budget per trade as a % of equity |
| `MAX_DRAWDOWN_PCT` | `5` | **Kill-switch** (issue #10): once drawdown from session peak exceeds this, all OPEN signals are rejected until recovery |
| `MIN_LIQ_BUFFER_ATR` | `2` | Minimum SL distance as a multiple of ATR(14) |
| `SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT` | Universe |
| `PAPER_EXCHANGE_URL` | (unset) | When set in `paper` mode, routes through the remote Rails broker |
| `PAPER_EXCHANGE_ACCOUNT_ID` | `default` | Account ID for the remote broker |

---

## Architecture

```
src/
  agents/           # Signal generators + RiskAgent + ExecutorAgent
    FundingArbAgent.ts       # funding harvest (short perp when funding positive)
    MomentumAgent.ts         # momentum breakout
    AdaptiveSuperTrendAgent  # ML-adaptive supertrend (LOCAL PAPER ONLY — see #4)
    PairsAgent.ts            # DISABLED — see #11
    RiskAgent.ts             # gating authority, drawdown kill-switch
    ExecutorAgent.ts         # order routing
  binance/
    client.ts                # BinanceService — paper/live/remote backend switch
    paperEngine.ts           # local in-memory paper engine (with flushOnShutdown — #5)
    paperExchangeClient.ts   # HTTP client for the remote Rails broker (with retry — #7)
    symbolRules.ts           # exchangeInfo precision cache
    indicators.ts            # ATR, sparkline
    adaptiveSuperTrend.ts    # indicator math
    performance.ts           # win rate / max drawdown / Sharpe
  ollama/
    advisor.ts               # veto / advise / ask (fail-closed on parse errors — #6)
  runtime/
    Orchestrator.ts          # main loop, funding boundary detection (#2), state emit
    telemetry.ts             # builds the cockpit state snapshot
  ui/                        # Ink TUI
  config.ts                  # zod-validated env config
  types.ts                   # shared types
  index.tsx                  # entrypoint with SIGINT/SIGTERM hooks
```

---

## Known gaps (cross-referenced to GitHub issues)

### #1 — SL/TP in remote-paper mode
**Fixed.** `BinanceService.submitRemoteOrder` now submits SL as a `stop_loss`
order and TP as a `bounded` order to the broker immediately after the market
fill. Exits fire server-side even when this agent is offline.

### #2 — Funding not wired into run loop
**Fixed.** `Orchestrator.maybePushFunding` detects when Binance's
`nextFundingTime` crosses (i.e. the next boundary jumps forward by 8h) and
pushes one funding event per symbol with the boundary timestamp. The broker
dedupes on `(paper_position_id, funding_time)`.

### #3 — Per-strategy attribution lost in remote/live
**Partial.** The agent now encodes the strategy in the `clientOrderId`
(`<symbol>-<strategy>-<ts>-<nonce>`). The broker persists this on the order
row but not yet on the position row — see paper_exchange issue #19 for the
per-strategy metadata migration that closes this gap end-to-end.

### #4 — AdaptiveSuperTrendAgent disabled in remote-paper/live
**Documented.** The agent's dynamic stop updates (`updateStops`) require
per-strategy position keying, which only the local PaperEngine has.
`Orchestrator.start()` already logs the disable reason at startup. Re-enable
once paper_exchange issue #19 ships.

### #5 — Paper engine 250ms debounce can drop last state on crash
**Fixed.** `PaperEngine.flushSync()` writes the state synchronously, and
`Orchestrator.flushOnShutdown()` is wired to SIGINT/SIGTERM in `App.tsx`.

### #6 — Ollama advisor was fail-open on parse errors
**Fixed.** `parseVerdict` now returns `VETO` on unparseable replies and on
unknown verdict strings — fail-closed for hard errors. Offline and network
errors still fail-open (PROCEED) because deterministic code owns the entry
decision; the veto is a belt-and-braces check.

### #7 — paperExchangeClient threw on non-204 with no retry
**Fixed.** 5xx errors and network errors now retry up to 2 times with
exponential backoff (250ms, 750ms). 4xx errors surface immediately as
`PaperExchangeHttpError` (a 4xx is a client error — retrying is wrong).

### #10 — MAX_DRAWDOWN_PCT was display-only
**Fixed.** `RiskAgent.isDrawdownBreached` tracks session-peak equity and
rejects all OPEN signals once drawdown exceeds the limit. Closes
(reduceOnly + opposite-side exits) still pass — reducing exposure is the
correct response to a drawdown breach.

### #11 — PairsAgent disabled
**Documented in code** (`Orchestrator.agents`). It signals a BTC/ETH ratio,
which is not an exchange symbol; re-enable once it emits two legs.

### #12 — getTrades() returns [] in remote-paper mode
**Documented in code** (`BinanceService.getTrades`). paper_exchange's ledger
isn't shaped like a per-strategy trade journal — closing this gap needs
paper_exchange issue #19 (per-strategy metadata migration).

---

## Testing

```bash
npm test            # node:test runner
npm run build       # tsc, typecheck only
```

---

## License

Proprietary — AlgoScalperAPI.
