#!/usr/bin/env node
import 'dotenv/config';
import { isTimeframe, TIMEFRAME_MS } from './domain/market.js';
import { buildPaperTradingApplication, resetPersistedBreaker } from './composition/buildPaperTradingApplication.js';
import { buildStrategies } from './composition/strategyCatalog.js';
import { validatePaperOnlyConfig } from './composition/validatePaperOnlyConfig.js';

/**
 * Paper-only entry point.
 *   tsx src/core/main.ts                                   run the paper engine
 *   tsx src/core/main.ts research BTCUSDT 15m 30 [folds]   replay the last 30 days on PaperExchange
 *   tsx src/core/main.ts reset-breaker <operator>          re-arm a tripped breaker (engine must be stopped)
 */
async function main(): Promise<void> {
  const config = validatePaperOnlyConfig(process.env);
  const [command, symbol, timeframe, days, folds] = process.argv.slice(2);

  if (command === 'reset-breaker') {
    if (!symbol) throw new Error('usage: reset-breaker <operator>');
    const previous = resetPersistedBreaker(config.statePath, symbol);
    console.log(`breaker ${previous.state} (${previous.reason ?? 'no reason'}) re-armed by ${symbol} in ${config.statePath}`);
    return;
  }
  const app = buildPaperTradingApplication(config);

  if (command === 'research') {
    if (!symbol || !timeframe || !isTimeframe(timeframe) || !(Number(days) > 0)) throw new Error('usage: research <SYMBOL> <1m|5m|15m|1h|4h|1d> <days> [folds]');
    const frame = TIMEFRAME_MS[timeframe];
    const end = Math.floor(Date.now() / frame) * frame;
    const bars = await app.marketData.getCandles(symbol, timeframe, end - Number(days) * 86_400_000, end);
    const strategies = buildStrategies(config.strategyIds, config.strategyParameters).filter((s) => s.requirements.primaryTimeframe === timeframe);
    if (strategies.length === 0) throw new Error(`no enabled strategy runs on ${timeframe}; set its "timeframe" in PAPER_CORE_STRATEGY_PARAMS`);
    const experiment = { name: `${symbol} ${timeframe} ${days}d`, symbol, timeframe, bars, strategies, limits: { ...config.limits, allowedSymbols: [symbol] }, ...config.research };
    const results = Number(folds) >= 2 ? await app.experiments.runFolds(experiment, Number(folds)) : [await app.runResearch(experiment)];
    for (const { events: _events, ...report } of results) console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command !== undefined) throw new Error(`unknown command "${command}"`);

  await app.start();
  const shutdown = () => void app.stop().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
