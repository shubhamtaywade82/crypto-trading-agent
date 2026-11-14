# PaperExchange-Only Trading Core

## Purpose

Use the existing trading core while making the dedicated paper runner fail closed unless **PaperExchange is the configured execution venue**.

The new command is:

```bash
npm run dev:paper-exchange
```

It is intentionally separate from the general `dev:paper` command. The general paper mode still supports the in-memory PaperEngine when no remote broker is configured; the dedicated command refuses that fallback.

## Required environment

Set these values in `.env`:

```dotenv
MODE=paper
BINANCE_TESTNET=off
PAPER_EXCHANGE_URL=http://127.0.0.1:3100
PAPER_EXCHANGE_ACCOUNT_ID=crypto-agent-paper
PAPER_EXCHANGE_API_KEY=<the same operator token configured in paper_exchange>
```

The runner defaults `PAPER_EXCHANGE_URL` to `http://127.0.0.1:3100` when it is omitted. The account ID and API key are deliberately not defaulted. It refuses startup when either is absent or blank.

If `MODE=live` is set in the environment, the command refuses to start rather than silently overriding it. It also refuses `BINANCE_TESTNET=on`.

The `predev:paper-exchange` lifecycle hook reuses `predev:paper`: it checks the configured PaperExchange health endpoint and, when the local service is unavailable, starts the Docker Compose service and runs the repository's migration/smoke-test steps. Set `PAPER_EXCHANGE_DIR` when the PaperExchange checkout is not at the existing default path.

## Runtime ownership

| Concern | Existing module | Authority |
|---|---|---|
| Strategy contract | `src/agents/BaseAgent.ts` | A strategy reads `MarketContext` and emits typed `Signal[]` |
| Strategy composition | `src/runtime/Orchestrator.ts` | Registers the active agent instances |
| Market features and context | `src/market/`, `src/marketdata/`, `src/microstructure/` | Deterministic market-data pipeline |
| Risk and sizing | `src/agents/RiskAgent.ts`, `src/risk/` | Deterministic; the LLM cannot approve around it |
| Order routing | `src/agents/ExecutorAgent.ts`, `src/binance/client.ts` | In paper mode, routes through the configured remote broker |
| Paper account and orders | `src/binance/remoteBroker.ts`, `src/binance/paperExchangeClient.ts` | PaperExchange owns account, margin, positions, orders, fills and exchange ledger |
| AI veto / synthesis | `src/ollama/advisor.ts`, `src/llm/` | Advisory only; no independent order placement or risk sizing |
| Historical research | `src/backtesting/ReplayService.ts`, `MarketDataFeed.ts`, `ExecutionSimulator.ts` | Deterministic replay with costs and no-lookahead rules |

The startup guard in `src/runtime/paperExchangeOnly.ts` verifies the mode, testnet setting, URL, account ID and operator token before loading the cockpit. With a valid PaperExchange configuration, `BinanceService.openFuturesPosition()` routes through `RemoteBroker`; it does not take the local PaperEngine fallback or the live Binance submission path.

Binance is a public market-data source in this runner. Do not place orders through `binance-sdk` or the older `binance` connector. API trading keys are not required for public market data.

## Add a strategy

Strategies already use the `BaseAgent` contract. Do not create a second order manager, risk engine, or execution adapter for a new strategy.

1. Add a class under `src/agents/` extending `BaseAgent`.
2. Implement `analyze(ctx: MarketContext): Promise<Signal[]>`. Read only the data in `ctx`; use closed candles for bar-based entries; return no signal when inputs are stale or incomplete.
3. Give the agent a stable `id` and `strategy` identifier. Each emitted signal must include a valid entry, stop-loss, and (where used) take-profit, plus a concise reason and the evidence/features used.
4. Import and instantiate the agent in the `agents` array in `src/runtime/Orchestrator.ts`.
5. Add unit tests for signal conditions, warm-up, closed-bar handling, and invalid/missing data.
6. Run historical replay before enabling it in the paper runner:

```bash
npm test
npm run backtest -- --symbol BTCUSDT --days 30 --funding
```

All new entries still pass the existing deterministic `RiskAgent`, execution-quality checks and kill switch. Strategies must not call PaperExchange or Binance trading methods directly. Exits continue through the shared position/exit path.

## Integration facts and limitations

### Binance SDK

The agent already uses `@nemesis-oss/binance-sdk` in its microstructure feed. However, the broader `BinanceService` still uses the older `binance` connector for several market-data calls because it also owns the legacy live adapter. The dedicated runner keeps that service in paper mode and routes orders to PaperExchange; this change does not perform a broad SDK migration.

The repository's current dependency pin is `@nemesis-oss/binance-sdk@3.2.0`; do not blindly upgrade it to the latest SDK. The SDK's current Kline response is a typed object shape, not the raw tuple shape used by the older connector. Any migration needs an isolated adapter and contract tests.

### PaperExchange fill semantics

The current `PaperExchangeClient.submitOrder()` sends `execution_price`. PaperExchange documents this as an agent-driven, price-pinned fill. This is deterministic and useful for paper workflow validation, but it does **not** mean the order was matched against historical/live bid-ask depth. Do not describe this path as tick/depth simulation.

PaperExchange also has a separate external historical replay API: an order is queued and executes at the next bar open. Its generated `clients/ts` package does not currently export the backtest run/dataset endpoints. That replay protocol is not wired into this runner.

The agent's own `ReplayService`/ `ExecutionSimulator` is the current research path. It models next-bar entry, spread/slippage, taker fees, funding (when requested), conservative intrabar stop/target ordering and gap-through stops. It is a local deterministic research simulator, not a PaperExchange account execution.

### Ollama SDK

The existing advisor uses `@nemesis-oss/ollama-sdk` through its `generateText` path and treats the result as an advisory veto. If a future component uses `chatWithSchema`, the SDK takes the Zod schema as its second argument and returns the parsed value directly; it does not return a `{ data }` wrapper.

## Deliberate non-goals of this first slice

- No new strategy or claim of positive expectancy.
- No switch to live Binance or Binance testnet.
- No replacement of the existing risk engine, broker, replay engine or strategy agents.
- No claim of realistic depth-aware fills. A separate market-event/quote-matching integration needs its own contract tests before the current pinned-price adapter is changed.
- No automatic strategy promotion based on an LLM response.
