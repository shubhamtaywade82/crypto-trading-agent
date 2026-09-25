# SMC ML Multi-Timeframe Execution

This strategy ports the supplied Pine Smart Money Concept ML logic into TypeScript while using @nemesis-oss/binance-sdk as the exchange boundary.

## Pipeline

    Binance USD-M futures WS kline close
            |
            v
    SmcMlRunner
            |
            +--> SDK REST klines: 5m / 15m / 1h / 4h (+1d optional)
            +--> SDK mark price
            |
            v
    SmcMlEngine
      - confirmed swing highs/lows
      - BOS / CHOCH
      - protected swing
      - ATR / volatility
      - FVG
      - order blocks
      - equal/swing liquidity
      - retest probability
      - liquidity first-touch probability
      - Bayesian logistic calibration
      - follow-through edge test
            |
            v
    SmcConfluence
      - timeframe-weighted score
      - agreement
      - no-trade reasons
            |
            v
    Execution candidates
      - MARKET
      - BREAK_CLOSE
      - RETEST_LEVEL
            |
            v
    Ollama SmcExecutionAdvisor
      - OPEN / ADD / EXIT / HOLD
            |
            v
    Deterministic portfolio policy
      - no position + aligned setup -> OPEN
      - same direction position + aligned setup -> ADD
      - strong opposite confluence -> EXIT
      - never reverse directly
            |
            v
    Binance SDK FuturesOps
      - risk-based sizing
      - tick/step/min-notional validation
      - bracket order

## Pine parity

The Pine retest event is a level touch. The Level Retest entry additionally requires a reclaiming close. The port preserves that distinction and exposes the reclaiming candle close as retestEntryPrice.

The supplied Pine signal bookkeeping scores TP1 partial exits. The initial Binance execution adapter places the protective stop and TP2; TP1 partial-close automation belongs in the execution/risk layer.

## Position policy

The LLM cannot invent levels, prices, quantity, leverage or indicators. It selects only an action and an existing candidate source.

    NO_POSITION + LONG confluence  -> OPEN LONG
    NO_POSITION + SHORT confluence -> OPEN SHORT
    LONG  + LONG confluence       -> ADD / HOLD
    SHORT + SHORT confluence      -> ADD / HOLD
    LONG  + strong SHORT          -> EXIT LONG
    SHORT + strong LONG           -> EXIT SHORT

Opposite-direction reversal is deliberately two-step: flatten first, then a later closed-candle cycle can create a new entry.

## Install

    npm install @nemesis-oss/binance-sdk@^3.0.0

The feature branch adds the dependency to package.json. The existing package-lock.json still needs regeneration on a machine with npm registry access.

## Example

    const runtime = new SmcMlRuntime(client, advisor, {
      timeframes: ['5m', '15m', '1h', '4h'],
      candleLimit: 300,
      confluenceMinimum: 0.35,
      riskPct: 1,
      leverage: 5,
    });

    const runner = new SmcMlRunner(client, runtime, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      autoExecute: false,
    });

    await runner.start(({ cycle }) => {
      console.log(JSON.stringify({
        symbol: cycle.analysis.symbol,
        confluence: cycle.analysis.confluence,
        decision: cycle.decision,
        candidate: cycle.selectedCandidate,
      }, null, 2));
    });

Start with autoExecute=false and paper/testnet execution. Enable live execution only after deterministic backtests and forward paper validation.
