# MiniCPM-2B Autonomous 24/7 Multi-Symbol Trading Fleet

A real-time, autonomous trading agent running on Binance USD-M Futures market data and powered by a local `openbmb/minicpm5-2b:latest` (Ollama) model (the **control model** — see [Model Selection](#6-model-selection--ab-routing)), connected to isolated accounts on `paper_exchange`.

---

## 1. Architectural Overview

```
                      ┌──────────────────────────────────────────────┐
                      │             Binance Market Data              │
                      │  - Real-time Sub-Second WebSocket Trades     │
                      │  - 15m & 1h Candles (multi-timeframe)        │
                      └──────────────────────┬───────────────────────┘
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │         BTC Market Context Aggregator        │
                      │   (BTCUSDT used strictly as macro anchor)    │
                      └──────────────────────┬───────────────────────┘
                                             │
                ┌────────────────────────────┼────────────────────────────┐
                ▼                            ▼                            ▼
       [ ETHUSDT Worker ]           [ SOLUSDT Worker ]           [ XRPUSDT Worker ]
      Account: `...-eth`           Account: `...-sol`           Account: `...-xrp`
                │                            │                            │
                └────────────────────────────┼────────────────────────────┘
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │    Local LLM (default: minicpm5-2b control)  │
                      │   - Swappable per symbol (FleetModels.ts)    │
                      │   - Dynamic SL / TP / Entry Decision         │
                      │   - Min 5% Return on Capital Target          │
                      └──────────────────────┬───────────────────────┘
                                             │
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │           paper_exchange Execution           │
                      │   - $980.00 Margin per position              │
                      │   - 10x Isolated Leverage                    │
                      │   - Instant WebSocket SL/TP Triggers         │
                      │   - Real-Time Live TUI Dashboard             │
                      └──────────────────────────────────────────────┘
```

---

## 2. Capital & Margin Allocation ($980 Margin on $1,000 Account)

### Sizing Mechanics
* **Account Initial Balance**: **$1,000.00 USD** per symbol account.
* **Effective Margin Used**: **$980.00 USD** (98% of total account capital).
* **Position Leverage**: **10x Isolated**.
* **Position Notional**: **$9,800.00 USD** ($980 × 10).
* **Buffer Kept in Cash**: **$20.00 USD** (2%).

### Why Reserve a $20.00 Fee Buffer?
When opening a futures position, the exchange validates available balance before placing the fill:
$$\text{Required Balance} = \text{Initial Margin} + \text{Taker Fee}$$

If the system committed 100% ($1,000.00) to margin:
1. At 10x leverage, notional is $10,000.00.
2. The taker fee (~0.04% – 0.05%) requires ~$4.00 to $5.00 cash upfront.
3. Total required balance becomes $1,004.50.
4. Because the balance is only $1,000.00, the exchange throws `402 Payment Required: account has 1000.0 available, needs 1004.50`.

Reserving 2% ($20.00) allows the order to fill reliably without hitting margin errors, while still deploying 98% of available capital into the trade.

---

## 3. Trade Objectives & Strategy Rules

1. **BTC Macro Anchor**:
   * `BTCUSDT` is monitored continuously for 1h/15m trend direction, momentum, and 24h performance. It is used as the macro market anchor and is not traded directly by the worker fleet.
2. **Minimum 5% Capital Profit Target**:
   * At 10x leverage, achieving a **5% return on capital** requires at minimum a **0.50% price move**:
     $$\text{Target Return} = \text{Price Move \%} \times \text{Leverage} \ge 0.5\% \times 10 = 5\%$$
   * For **LONG**: `takeProfit >= currentPrice * 1.005`
   * For **SHORT**: `takeProfit <= currentPrice * 0.995`
3. **Strict Invalidation (SL)**:
   * Stop Loss is anchored to local swing structure / support / resistance identified by the LLM.
   * Enforces Risk/Reward Ratio $(R/R) \ge 1.5$.
4. **Real-Time Exit Execution**:
   * Stop Loss and Take Profit levels are evaluated **instantly on every sub-second Binance WebSocket price tick** rather than waiting for candle closes.

---

## 4. Isolated Paper Accounts

Each symbol runs in an independent, isolated ledger on `paper_exchange`:

| Symbol | Paper Account ID | Starting Margin | Leverage | Margin Type |
| :--- | :--- | :--- | :--- | :--- |
| **ETHUSDT** | `crypto-minicpm-eth` | $1,000.00 | 10x | Isolated |
| **SOLUSDT** | `crypto-minicpm-sol` | $1,000.00 | 10x | Isolated |
| **XRPUSDT** | `crypto-minicpm-xrp` | $1,000.00 | 10x | Isolated |

---

## 5. Running the 24/7 Live Fleet

### Prerequisites
1. Ensure Ollama is running with `openbmb/minicpm5-2b:latest` (or the model you selected):
   ```bash
   ollama run openbmb/minicpm5-2b:latest
   ```
2. Ensure the local paper exchange backend is up:
   ```bash
   cd /home/nemesis/projects/apps/paper_exchange && docker compose up -d
   ```

### Launch Command
From the `crypto-trading-agent` project directory:
```bash
npm run fleet            # alias for: npx tsx scripts/run-minicpm-fleet.ts
```

Equivalently: `npm run fleet:shadow` (same command — the fleet ships in shadow mode; entries stay off).

Entry execution is opt-in and deliberately not an npm alias. To arm entries the operator must
set the environment variable explicitly on the command line, so the decision is visible in
shell history and process listings:
```bash
MINICPM_ENTRIES=on npx tsx scripts/run-minicpm-fleet.ts
```

For long production runs spanning weeks with memory capping:
```bash
NODE_OPTIONS="--max-old-space-size=512" npm run fleet
```

### Dashboard View
The runner displays a continuous live terminal cockpit updated up to 4 times per second via real-time WebSocket ticks:
* System uptime & clock.
* Symbol state (`IDLE`, `ANALYZING`, `IN_POSITION`).
* Real-time mark price, entry price, position size, and uPnL.
* Total realized PnL and current account equity.
* Latest LLM rationale and SL/TP levels — each symbol's reasoning is prefixed with its model tag, and the footer shows the fleet's model assignment.

---

## 5b. Embedded in `npm run dev` (the FLEET view)

The fleet also runs **inside the main dev cockpit** — `npm run dev` hosts a `FleetSupervisor`
(`src/minicpm/FleetSupervisor.ts`) that shares the exact worker code path with the standalone
runner (`SymbolTraderWorker` + `MiniCpmService` + `FleetModels`), so embedded and standalone
behavior are identical by construction. Press **Tab** or **m** to cycle views:
`cockpit → MTF → liquidity → FLEET`.

Properties of the embedded fleet:

* **Self-contained**: it runs its own Binance market-data snapshot loop and trade WebSocket —
  hosting the fleet adds zero code paths to the main agent's decision loop.
* **Parks, never blocks**: without `PAPER_EXCHANGE_API_KEY` (or with `FLEET_IN_DEV=off`) the
  supervisor parks itself with a cockpit log line explaining why; `npm run dev` starts normally
  and the FLEET view shows the parked explanation and the enable instructions.
* **Sends its own `[FLEET]` Telegram trade notifications**: every worker's entry fill (buy/sell),
  exit fill (stop-loss / take-profit / break-even) and break-even lock posts a `[FLEET] SYMBOL
  BUY/SELL` card (`src/minicpm/FleetTelegram.ts`) to the same Telegram bot/chat config the
  operator already uses (`TELEGRAM_TRADING_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN`, plus
  `TELEGRAM_CHAT_ID`) — nothing new to configure. The card carries the symbol, the order side,
  the entry/exit price, SL/TP, the realized PnL on exits, the model tag that produced the
  decision, and the model's stated reason. Two guarantees hold by construction: (1) the fleet
  never touches the main agent's alert pipeline — no `sendAlert`, no `AlertEvent`, no
  `NotificationEngine`, no opsHooks (enforced by a unit test; the fleet calls only the low-level
  `sendTelegram`) — so the main agent's alert stream is unaffected and every fleet card is
  visually distinguishable by its `[FLEET]` prefix; (2) notifications are fire-and-forget —
  unconfigured Telegram or a Telegram outage silently skips sending and trading continues.
  Opt out with `FLEET_TELEGRAM=off`. Shadow-mode decisions (no order) never notify; only
  actual fills and protection moves do. The same notifications run in the standalone fleet.
* **Same entry rule as standalone**: entries stay OFF (shadow, R1) unless the operator exports
  `MINICPM_ENTRIES=on` on the command line.
* Same model selection as the standalone runner (`--model`, `--route`, `FLEET_MODEL`,
  `FLEET_MODEL_ROUTE`, `--host`, `--timeout-ms` flags/env all work on `npm run dev` too).

```bash
npm run dev                                        # fleet embeds in shadow mode when the token exists
FLEET_IN_DEV=off npm run dev                       # main agent only, no embedded fleet
FLEET_MODEL_ROUTE='ETH=qwen3.5:2b' npm run dev     # embedded A/B routing, same rules as standalone
MINICPM_ENTRIES=on npm run dev                     # ARM entries in the embedded fleet (explicit, visible)
```

---

## 6. Model Selection & A/B Routing

The fleet's decision LLM is **not hard-coded**. `MiniCpmService` is model-agnostic — the
prompt and the JSON validation contract are identical for every model — and the runner
accepts a fleet-wide default plus per-symbol overrides:

```bash
# Fleet-wide model (registry id or raw Ollama tag); default is the MiniCPM5-2B control
npm run fleet -- --model qwen3.5-2b
FLEET_MODEL=qwen3.5:2b npm run fleet

# Per-symbol A/B routing under identical market conditions
npm run fleet -- --route 'ETH=qwen3.5:2b,SOL=lfm2.5-2.6b,XRP=minicpm5-2b'
FLEET_MODEL_ROUTE='ETH=qwen3.5-2b,SOL=lfm2.5-2.6b' npm run fleet

# LLM host and per-request timeout (raise for thinking models on modest GPUs)
npm run fleet -- --host http://127.0.0.1:11434 --timeout-ms 60000
```

Env vars: `FLEET_MODEL`, `FLEET_MODEL_ROUTE`, `FLEET_LLM_HOST`, `FLEET_LLM_TIMEOUT_MS`.
Flags win over env vars. A route naming a symbol the fleet does not trade fails at boot —
a typo can never silently strand a worker on the control model. Every opened position is
persisted with `openedByModel` in `data/minicpm-state.json` so model comparison ledgers
attribute outcomes correctly even when the assignment changes mid-flight.

### Curated shortlist (src/minicpm/FleetModels.ts)

| id | Ollama tag | Size | Marketed strengths | Suggested role here |
|---|---|---|---|---|
| `minicpm5-2b` *(default)* | `openbmb/minicpm5-2b:latest` | ~2.0 GB | lightweight coding, local trading analysis | **control** |
| `qwen3.5-2b` | `qwen3.5:2b` | 2.7–3.1 GB | thinking, tool use, instruction following | trading-analysis (first A/B candidate) |
| `qwen3-4b` | `qwen3:4b` | 2.5 GB | thinking, function calling, agent workflows | reasoning |
| `lfm2.5-2.6b` | `LiquidAI/lfm2.5-2.6b` | 1.7 GB | native tool calling, agentic RL | tool-execution |
| `granite4.2-3b` | `granite4.2:3b` | 2.2 GB | native tools, structured JSON | structured output |
| `nemotron3-nano-4b` | `nemotron-3-nano:4b` | 2.8–2.9 GB | thinking, tools, unified modes | reasoning |
| `qwen3-1.7b` | `qwen3:1.7b` | 1.4 GB | tool selection | lightweight routing |
| `lfm2.5-1.2b` | `LiquidAI/lfm2.5-1.2b-instruct` | 0.73 GB | tool selection, tiny footprint | lightweight routing |

```bash
ollama pull openbmb/minicpm5-2b:latest   # control (already installed)
ollama pull qwen3.5:2b                    # first challenger
ollama pull LiquidAI/lfm2.5-2.6b          # agentic candidate
ollama pull granite4.2:3b                 # structured-JSON candidate
ollama pull qwen3:4b
ollama pull qwen3:1.7b
ollama pull LiquidAI/lfm2.5-1.2b-instruct
ollama pull nemotron-3-nano:4b
```

### What the shortlist is NOT

The shortlist records what models are *marketed for*, not what they have proven on this
fleet. Third-party benchmarks (JevBench, BFCL, ToolSandbox, Local Agent Bench) each measure
one run under their own conditions; none of them measure this fleet's objective — net
post-cost expectancy per trade. A challenger model earns exactly nothing until its own
fleet ledger clears the same promotion gates as any strategy change (`npm run
self-improve`, docs/RESEARCH_SYSTEM.md): positive OOS mean, bootstrap LCB > 0, DSR from
the actual per-trade Sharpe, and a sample large enough for the claimed edge.

Recommended evaluation protocol (identical conditions per candidate):
1. Keep `minicpm5-2b` as the control on one symbol; route the challenger to another
   symbol on the same feed, same prompt, same risk rules.
2. Run shadow mode (entries off) first; compare decision quality before comparing PnL.
3. Raise `--timeout-ms` for thinking models; record latency alongside decisions.
4. Give every model the same number of evaluation cycles before comparing ledgers.
5. Remember: download size is not VRAM consumption — a 1.7 GB model with a large context
   can still exceed an 8 GB GPU alongside the rest of the fleet.
