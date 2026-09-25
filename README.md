# crypto-trading-agent

A TypeScript agent for Binance USD-M perpetual futures. Multi-strategy signal
generation, risk gating, an optional Ollama LLM veto layer, and a TUI cockpit
built on Ink. Routes orders to either a local in-memory paper engine, a remote
`paper_exchange` Rails broker (over HTTP), or live Binance.

---

## Modes

| `MODE` | Backend | SL/TP/trailing exits | Per-strategy attribution |
| --- | --- | --- | --- |
| `paper` (default, no `PAPER_EXCHANGE_URL`) | Local in-memory `PaperEngine` | Agent-side, checked on every price tick | Yes (positions keyed by `symbol+strategy`) |
| `paper` + `PAPER_EXCHANGE_URL` | Remote `paper_exchange` Rails broker via `RemoteBroker` | Agent-side reduce-only market orders (the broker never evaluates resting orders and has no price feed). Liquidation, fees and funding are exchange-side | Yes: one account, a symbol is owned by the strategy that opened it |
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

The cockpit needs at least 160×53 terminal cells (`MIN_COLS` x `MIN_ROWS` in `src/ui/panels.tsx`). Use `?` inside the cockpit
for the command cheatsheet.

---

## Configuration

All configuration is via environment variables (validated with `zod` in
`src/config.ts`). The defaults shown below are the schema defaults, NOT
necessarily what's in `.env.example` — they were inconsistent before issue #9
was fixed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODE` | `paper` | `paper` or `live` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | (empty) | Required for `MODE=live` |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama daemon URL |
| `OLLAMA_MODEL` | `gemma4:31b` | Model used for veto/advise/ask |
| `MIN_LEVERAGE` | `5` | Floor for the dynamic-leverage calculation |
| `MAX_LEVERAGE` | `10` | Ceiling for the dynamic-leverage calculation |
| `MAX_EXPOSURE_PCT` | `80` | Cap on notional as a % of equity |
| `RISK_PER_TRADE_PCT` | `1` | Risk budget per trade as a % of equity |
| `MAX_DRAWDOWN_PCT` | `5` | **Kill-switch** (issue #10): once drawdown from session peak exceeds this, all OPEN signals are rejected until recovery |
| `MIN_LIQ_BUFFER_ATR` | `2` | Minimum SL distance as a multiple of ATR(14) |
| `SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT,AVAXUSDT` | Universe |
| `AUDIT` / `ALERTS` | `off` | Audit trail and Telegram alerts, see [Ops](#ops-audit-trail-telegram-alerts-kill-switch) |
| `PAPER_EXCHANGE_URL` | (unset) | When set in `paper` mode, routes through the remote Rails broker (`http://127.0.0.1:3100`) |
| `PAPER_EXCHANGE_ACCOUNT_ID` | (none) | Account for the remote broker; **required** when `PAPER_EXCHANGE_URL` is set in `paper` mode (startup fails without it); `.env.example` suggests `crypto-agent` |

---

## Paper trading on paper_exchange

Set `PAPER_EXCHANGE_URL` (and `PAPER_EXCHANGE_ACCOUNT_ID`) with `MODE=paper` and the agent trades on the
`paper_exchange` Rails broker instead of the local engine.

**Start the exchange:** `docker compose up -d` in `/home/nemesis/projects/apps/paper_exchange`
(health check: `GET http://127.0.0.1:3100/up`).

**Who holds what.** The exchange holds the wallet, positions, fees, funding and liquidations. The agent holds
strategy state and shows the exchange's numbers: equity is `available_balance + locked_margin + unrealized`
(re-marked from live ticks), so fees and funding are inside it. Journal PnL per trade is gross; fees and funding
show up in equity only.

**Account.** One shared account (`PAPER_EXCHANGE_ACCOUNT_ID`). On startup the agent creates it with 100 000
margin only if it does not exist; it never resets an existing account.

**Ownership rule.** Positions net per symbol. A symbol is owned by the strategy that opened it: other
strategies are refused before any order is sent. The owner may scale in (same side) or flip (full reduce-only
close journaled `FLIP`, then a new position). A position on the exchange with no sidecar entry (manual trade,
lost sidecar) is adopted as `EXECUTOR-ε`, without SL/TP, and strategies never touch it.

**Exits are agent-side.** SL, TP and trailing stops are evaluated against the agent's own price ticks; a breach
sends a reduce-only market order for the exact quantity, one exit in flight per symbol. If the agent is offline
nothing exits (the broker has no price feed); liquidation is the only server-side exit.

**Sidecar `data/remote-state.json`.** Holds owner, SL/TP and initial risk per position, plus the closed-trade
journal (last 1000). The file is bound to one account id. After resetting the exchange account, delete it.

**Outage behavior.** While the exchange is down, entries are refused (`VenueUnavailableError`) and nothing is
sent. Exits queue and retry (about once a second) under one client order id, and complete after recovery, at the
worse of the trigger and the current mark for stops. The loop and cockpit keep running on cached data: the
footer shows `venue paper_exchange (<account>) ●connected|degraded|down` and the equity line shows `stale`
when down.

**End-to-end check.** `npm run e2e:paper-exchange` runs scenarios S1–S24 (design spec:
`docs/superpowers/specs/2026-09-21-paper-exchange-end-to-end-design.md`) through `RemoteBroker` and prints one
PASS/FAIL/SKIPPED line per scenario with the agent and exchange numbers it compared; non-zero exit on any failure.

- `E2E_BACKEND=fake` (default): in-memory exchange replica, no network.
- `E2E_BACKEND=real`: needs `PAPER_EXCHANGE_URL`; creates a throwaway account `e2e-<epoch>` (the run refuses any
  other account id) and trades only synthetic symbols `E2EAUSDT`, `E2EBUSDT`, ... because the exchange's mark
  prices and liquidation scan are shared across accounts. Scenarios that need a controlled outage or a lost
  response (S14, S15) are `SKIPPED (fake-only)`; S13 runs against a closed port. The exchange cannot delete
  accounts, so `e2e-*` accounts stay in its database.

---

## Ops: audit trail, Telegram alerts, kill-switch

Everything here is off by default and isolated from trading: an audit, alert or Telegram failure is swallowed
before it reaches the loop, and sends are fire-and-forget, so trading never waits on Telegram. With a flag off its
hook does nothing: no file is written, no request is made, no timer is started.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUDIT` | `off` | `on` appends one JSON line per decision step to `EVENTS_PATH` |
| `ALERTS` | `off` | `on` sends Telegram cards (and starts the daily digest timer) |
| `EVENTS_PATH` | `data/events.jsonl` | Audit trail; rotated to `<file>.1` at 5 MB |
| `NOTIFICATIONS_PATH` | `data/notifications.json` | Optional subscription JSON (missing or invalid means every class on) |
| `TELEGRAM_CHAT_ID` | (unset) | Destination chat, required to send |
| `TELEGRAM_BOT_TOKEN` | (unset) | Shared bot, used when a channel has no bot of its own |
| `TELEGRAM_TRADING_BOT_TOKEN` | (unset) | Bot for TRADE and SIGNAL cards |
| `TELEGRAM_ALERTBOT_BOT_TOKEN` | (unset) | Bot for SYSTEM and digest cards |
| `TELEGRAM_DRY_RUN` | (unset) | `1` writes each card to the cockpit log (`[telegram dry-run] ...`) instead of sending; works without tokens |

**Enable it:** set `AUDIT=on` and/or `ALERTS=on` in `.env`. For alerts, add `TELEGRAM_CHAT_ID` plus a bot token
(`TELEGRAM_BOT_TOKEN`, or the two per-channel tokens). Try it first with `TELEGRAM_DRY_RUN=1`. Tokens are never
logged. The audit trail and the alerts are independent of `RISK_ENGINE`.

**Audit trail.** Each signal keeps one `decisionId` (the signal's `id`) from `signal` through `gate`, `veto`,
`order`, `exit` and `journal`; refusals are `refusal` events with the same id. System events (`venue`, `circuit`,
`crash`, `killswitch`, `digest`) carry none. Exits are detected from the closed-trade journal, so a stop, a
liquidation or an off-agent close is reported even when the loop logged nothing. A position opened before a restart
has no `decisionId` on its exit.

**What each alert covers** (a card is audible unless its severity is below IMPORTANT):

| Class | Cards | Severity |
| --- | --- | --- |
| TRADE (trading bot) | position opened, scale-in, flip; exit with reason, gross PnL and R (R needs the position's initial stop) | fill: SIGNAL; exit: IMPORTANT; liquidation: CRITICAL |
| SIGNAL (trading bot) | entry accepted; entry refused (risk gate or executor); entry vetoed by the advisor | accepted: SIGNAL; refused/vetoed: WATCH (silent) |
| SYSTEM (alert bot) | venue degraded / down / recovered, websocket drop after it was up, loop crash, circuit-breaker change, kill-switch on/off | down, crash, HALTED/EMERGENCY, kill-switch: CRITICAL; others IMPORTANT (websocket reconnecting: WATCH) |
| RESEARCH (alert bot) | daily digest at 00:05 UTC for the previous UTC day: PnL, trades, win rate, profit factor, best/worst, drawdown, refusals by reason, per-strategy results (gross realized PnL; a dash where a ratio is undefined) | WATCH (silent) |

### Institutional-style setup maps

The alert pipeline can also publish one deterministic `SETUP` map per symbol instead of relying only on entry/refusal cards. A setup map summarizes the current directional regime, HTF/LTF structure, liquidity, crowding and derivatives context, then presents up to three executable hypotheses (liquidity sweep, pullback/retest, breakout/retest) with entry zone, invalidation, stop, targets, reward/risk, trigger, flow hypothesis, expected move window and thesis expiry.

These are **market-derived hypotheses**, not claims of privileged institutional intent. The flow field explicitly describes an inference from observable positioning/aggression/liquidity data. Expected move windows are currently deterministic volatility/ATR model estimates; they are not yet historical time-to-target quantiles. The setup engine never routes an order by itself: the existing risk gate, execution-quality checks and executor remain authoritative.

Setup maps are generated from the same `MarketState` already built by `Orchestrator.gatherContext()`. `WATCHING` cards use WATCH severity; `TRIGGERED` cards use SIGNAL severity. Setup alerts are deduplicated with a 15-minute cooldown, while a WATCHING → TRIGGERED transition is emitted immediately. Configure them through the existing `SETUP` class in `NOTIFICATIONS_PATH`; no new Telegram credentials are required.


Repeats are dropped by fingerprint: a refused signal for the same symbol, agent and reason at most once per 15
minutes, and the same system alert at most once per 5 minutes. Optional `NOTIFICATIONS_PATH` JSON turns classes,
symbols or a minimum severity off, for example `{"notifications": {"signal": false, "minSeverity": "IMPORTANT"}}`
(SYSTEM CRITICAL alerts are never suppressed).

**Kill-switch.** Press `k` in the cockpit to halt new entries: every OPEN is refused with `kill-switch: manual`,
whatever `RISK_ENGINE` says, and the risk row of the fleet panel shows `KILL-SWITCH`. Exits, stops and manual closes
are never affected. Press `k` again to resume. The state is saved to `data/kill-switch.json`, so a restart does not
resume trading by itself (press `k` or delete the file to clear it). A circuit-breaker HALTED/EMERGENCY (with
`RISK_ENGINE=on`) refuses entries on its own and is announced as a SYSTEM alert; it does not touch the kill-switch.

With `MODE=live` the venue keeps no per-strategy trade journal, so `RISK_ENGINE=on` cannot see realized losses there: the daily-loss and loss-streak limits stay inactive (only drawdown applies) and a warning is logged at start.

---

## Architecture

```
src/
  agents/           # Signal generators + RiskAgent + ExecutorAgent
    FundingArbAgent.ts       # funding harvest (short perp when funding positive)
    MomentumAgent.ts         # momentum breakout
    AdaptiveSuperTrendAgent  # ML-adaptive supertrend (paper modes, local and remote)
    PairsAgent.ts            # DISABLED — see #11
    RiskAgent.ts             # gating authority, drawdown kill-switch
    ExecutorAgent.ts         # order routing
  binance/
    client.ts                # BinanceService — paper/live/remote backend switch
    paperEngine.ts           # local in-memory paper engine (with flushOnShutdown — #5)
    paperExchangeClient.ts   # HTTP client for the remote Rails broker (retry, typed errors — #7)
    remoteBroker.ts          # strategy-aware view of the shared exchange account
    remoteOrders.ts          # entries, agent-side reduce-only exits, idempotent client order ids
    remoteReconcile.ts       # aligns the sidecar with the exchange (adopt, journal off-agent closes)
    remoteState.ts           # data/remote-state.json sidecar + wallet-equity projections
    remoteFunding.ts         # funding-boundary detection and push
    stopRules.ts             # SL/TP breach rules shared by the local engine and the remote broker
    symbolRules.ts           # exchangeInfo precision cache
    indicators.ts            # ATR, sparkline
    adaptiveSuperTrend.ts    # indicator math
    performance.ts           # win rate / max drawdown / Sharpe
  ollama/
    advisor.ts               # veto / advise / ask (fail-closed on parse errors — #6)
  ops/                       # audit trail, alerts, Telegram sender, cards, kill-switch, hooks
  runtime/
    Orchestrator.ts          # main loop, state emit
    opsHooks.ts              # circuit/performance ops, hook wiring from the flags, daily digest timer
    telemetry.ts             # builds the cockpit state snapshot
  ui/                        # Ink TUI
  config.ts                  # zod-validated env config
  types.ts                   # shared types
  index.tsx                  # entrypoint with SIGINT/SIGTERM hooks
```

---

## Known gaps (cross-referenced to GitHub issues)

### #1 — SL/TP in remote-paper mode

**Superseded.** Server-side stop orders are gone: the broker never re-evaluates resting orders and has no price
feed. Exits are agent-side reduce-only market orders (see "Paper trading on paper_exchange"), so nothing exits
while the agent is offline.

### #2 — Funding not wired into run loop

**Fixed.** `RemoteBroker.observeFunding` detects when Binance's `nextFundingTime` jumps forward (the next
boundary moves by 8h) and pushes one funding event per symbol with the boundary timestamp. The broker dedupes on
`(paper_position_id, funding_time)`. A failed push is logged and not retried.

### #3 — Per-strategy attribution lost in remote/live

**Fixed for remote paper** by the ownership rule (a symbol belongs to the strategy that opened it; the sidecar
records it). Live Binance positions are still per-symbol.

### #4 — AdaptiveSuperTrendAgent disabled in remote-paper/live

**Fixed for remote paper.** Its stop updates are persisted in the sidecar only for positions it owns. It stays
disabled in live mode (`Orchestrator.start()` logs why).

### #5 — Paper engine 250ms debounce can drop last state on crash

**Fixed.** `PaperEngine.flushSync()` writes the state synchronously, and
`Orchestrator.flushOnShutdown()` is wired to SIGINT/SIGTERM in `App.tsx`.

### #6 — Ollama advisor was fail-open on parse errors

**Fixed.** `parseVerdict` now returns `VETO` on unparseable replies and on
unknown verdict strings — fail-closed for hard errors. Offline and network
errors still fail-open (PROCEED) because deterministic code owns the entry
decision; the veto is a belt-and-braces check.

### #7 — paperExchangeClient threw on non-204 with no retry

**Fixed.** 5xx errors and network errors retry up to 2 times with exponential
backoff (250ms, 500ms) and end as `VenueUnavailableError`. 4xx errors surface
immediately as `OrderRejectedError` (retrying a client error is wrong).

### #10 — MAX_DRAWDOWN_PCT was display-only

**Fixed.** `RiskAgent.isDrawdownBreached` tracks session-peak equity and
rejects all OPEN signals once drawdown exceeds the limit. Closes
(reduceOnly + opposite-side exits) still pass — reducing exposure is the
correct response to a drawdown breach.

### #11 — PairsAgent disabled

**Documented in code** (`Orchestrator.agents`). It signals a BTC/ETH ratio,
which is not an exchange symbol; re-enable once it emits two legs.

### #12 — getTrades() returns [] in remote-paper mode

**Fixed.** The trade journal lives in the sidecar (`data/remote-state.json`); the agent computes its own
statistics from it instead of the exchange's `/api/performance`.

---

## Testing

```bash
npm test                  # node:test runner
npm run build             # tsc, typecheck only
npm run e2e:paper-exchange  # S1-S24 through RemoteBroker (E2E_BACKEND=fake|real, see above)
```

---

## License

Proprietary — AlgoScalperAPI.
