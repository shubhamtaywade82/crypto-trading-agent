# Paper-only core (`src/core`)

A ports-and-adapters trading core that executes on PaperExchange and nowhere else. Binance is a read-only
market-data source; Ollama is an optional advisor that can only veto. Strategies are plugins.

It runs beside the existing cockpit (`src/index.tsx`), which is unchanged and keeps its own `MODE` switch.
The core does not import the cockpit's config, its `BinanceService`, or any live-order module.

```
npm run paper:core                                  # paper engine: bar-close events -> PaperExchange orders
npm run paper:core:research -- BTCUSDT 15m 30       # replay the last 30 days on a PaperExchange external run
npm run paper:core:research -- BTCUSDT 15m 90 3     # the same over 3 consecutive folds
npm run test:core                                   # the core's tests only
```

## Pipeline

One path for real time and for replay (`application/engine/TradingOrchestrator.ts`):

```
bar.closed event
  -> market snapshot (closed bars only)        MarketDataPort
  -> features                                  FeatureEngine / FeatureRegistry
  -> strategies                                StrategyRegistry / StrategyRunner
  -> one decision per symbol per bar           DecisionBuilder  (opposite signals = no trade)
  -> sizing                                    PositionSizer    (risk budget at the stop, costs included)
  -> advisor, optional, veto only              DecisionAdvisorPort
  -> risk pipeline, every rule, all findings   RiskPipeline + risk/rules
  -> immutable order command                   buildPlaceOrderCommand (needs the pipeline's approval token)
  -> paper order, protection, reconciliation   PlacePaperOrderHandler -> PaperExecutionPort
  -> event stream                              TradingEventBus -> JSONL journal
```

Events are processed one at a time over the whole account. A bar is handled once; a repeat or an older bar is skipped.

## Layout

| Path | Contents |
| --- | --- |
| `domain/` | Market, strategy, risk, portfolio and order types; the order state machine. No I/O, no SDK. |
| `ports/` | `MarketDataPort`, `HistoricalDataPort`, `PaperExecutionPort`, `PortfolioPort`, `DecisionAdvisorPort`, `ReplaySessionPort`, mark feed, journal, clock. |
| `application/` | Orchestrator, bar-close source, mark pump, feature engine, strategy registry and runner, decision builder, sizer, risk pipeline, circuit breaker, session tracker, order handler. |
| `risk/rules/` | The 17 independent risk rules and their standing order. |
| `strategies/` | `momentum-ema-cross`, `range-breakout`, `mean-reversion-zscore`, `cross-sectional-momentum`. |
| `adapters/` | Binance (public data), PaperExchange (execution, portfolio, external replay), Ollama (advisor), JSONL journal and state file, decorators (cache, retry, metrics, execution logging). |
| `research/` | `ExperimentRunner` (replay, folds, decision digest) and `PerformanceAnalyzer`. |
| `composition/` | `validatePaperOnlyConfig`, `strategyCatalog`, `buildPipeline`, `buildPaperTradingApplication`. The only code that names concrete adapters. |

## Paper-only guarantees and what enforces them

| Guarantee | Enforced by |
| --- | --- |
| `MODE` other than `paper` does not start | `validatePaperOnlyConfig` throws `PaperOnlyViolationError`; `tests/core.config.test.ts` |
| No live-order module or package is reachable | Import-graph walk in `tests/core.architecture.test.ts`: the core reaches three legacy files (`paperExchangeClient`, `indicators`, `jsonMode`) and never the `binance` or CoinDCX packages |
| The Binance client cannot place an order | Built without credentials and with the SDK's `readOnly` policy; the test calls `placeOrder`/`createOrder` on it and gets `PolicyViolationError` before any request |
| Execution has one venue | `PaperExecutionPort.venue` is the literal `'paper_exchange'`; only the two PaperExchange adapters implement the port; `buildPipeline` refuses anything else |
| Every order has an accepted risk decision | `buildPlaceOrderCommand` needs an approval token only `RiskPipeline` can mint |
| The advisor cannot originate, resize or override | Its reply schema has two fields (verdict, reason); it runs before the risk pipeline, which still judges the trade |
| An entry never stays unprotected | Live paper: stop and target are attached after the fill, or the position is flattened; if both fail the breaker trips. Replay: stop and target travel on the order |
| An unknown order outcome is not retried blindly | Reconcile by client order id, resend at most once under the same id, otherwise `UNKNOWN` and the breaker trips |

## Adding a strategy

1. Implement `Strategy` (`domain/strategy.ts`) under `strategies/<name>/`: an id, a version, a zod parameter schema,
   `requirements` (timeframe, feature keys, warm-up) and a pure `evaluate`.
2. Add one line to `composition/strategyCatalog.ts`.
3. Enable it: `PAPER_CORE_STRATEGIES=...,<id>`; override parameters with
   `PAPER_CORE_STRATEGY_PARAMS='{"<id>":{"timeframe":"1h"}}'`.

Nothing in `application/`, `risk/` or `adapters/` changes. A new indicator is registered once in
`application/features/FeatureRegistry.ts` and requested by key (`name:period`).

A signal is an entry with its own stop and target. Exits are the venue's protective orders; strategies do not emit
exit signals.

## Configuration

`PAPER_EXCHANGE_URL` and `PAPER_EXCHANGE_ACCOUNT_ID` are required. Risk limits use the repository's existing names
(`RISK_PER_TRADE_PCT`, `MAX_LEVERAGE`, `MAX_EXPOSURE_PCT`, `MAX_DAILY_LOSS_PCT`, `MAX_DRAWDOWN_PCT`, `MAX_LOSS_STREAK`,
`MAX_CONCURRENT_POSITIONS`, `TAKER_FEE_RATE`, `SLIPPAGE_BUFFER_RATE`, `SYMBOLS`). Core-specific settings are prefixed
`PAPER_CORE_` and listed in `.env.example`. Binance and CoinDCX credentials are never read.

Operator controls:

- Kill switch: create the file named by `PAPER_CORE_KILL_FILE` (default `data/paper-core.KILL`). Every entry is refused while it exists.
- Circuit breaker: trips on the drawdown limit, an order with an unknown outcome, or a position left without a stop.
  It is stored in `PAPER_CORE_STATE` and stays tripped across restarts. To re-arm, stop the engine, inspect the
  account on PaperExchange, then run `tsx src/core/main.ts reset-breaker <operator>`.

## Two execution paths, and which to trust

| Path | Fill | Use |
| --- | --- | --- |
| Paper trading (`paper:core`) | PaperExchange fills the market order at the reference price the order carries, which is a Binance mark, not a bid or ask | Forward testing the plumbing and the risk envelope |
| Research (`paper:core:research`) | PaperExchange external replay: the order queues and fills at the next bar's open plus `slippage_bps`; stops and targets resolve inside the bar | Evaluating a strategy |

The replay is OHLC-bar fidelity and single-symbol per run. It carries no funding or open-interest history, so a
strategy that reads them sees `null` there, and `cross-sectional-momentum` cannot be evaluated on it.

## Not done

- The adapters are tested against an in-memory stand-in that follows the PaperExchange controllers' request and
  response shapes. They have not been run against a live PaperExchange instance.
- Real-time events come from polling the closed bar after each boundary, not from a WebSocket kline stream.
- `quantityStep` and `minNotional` are one value for all symbols.
- The legacy cockpit still has its live mode. Removing it is a separate decision.
