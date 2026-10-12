/**
 * Backtest CLI — replays the full decision pipeline over public Binance klines.
 *
 *   npx tsx scripts/backtest.ts [--symbol BTCUSDT] [--days 30] [--end-days-ago 0] [--equity 1150]
 *                                [--funding] [--decisions data/backtest-decisions.jsonl]
 *                                [--position-manager on|off] [--source api|archive]
 *
 * Fetches public USD-M klines (15m/1h/4h — the timeframes the state layer
 * consumes), then runs the same agents, fusion, risk gate and execution model
 * the orchestrator runs, on a no-lookahead feed with spread, slippage, taker
 * fees and conservative intrabar exits.
 *
 * Every series passes the candle integrity gate (src/backtesting/candleIntegrity.ts) before it is replayed: a gap, duplicate,
 * off-grid bar or broken OHLC invariant aborts the run. The window is trimmed to complete bars, so the forming bar never enters.
 */
import { ReplayService } from '../src/backtesting/ReplayService.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';
import type { ReplayData } from '../src/backtesting/types.js';
import { loadValidatedKlines, type KlineSource } from '../src/backtesting/klineLoader.js';

const TIMEFRAMES: NativeTimeframe[] = ['15m', '1h', '4h'];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const symbol = arg('symbol', 'BTCUSDT').toUpperCase();
const days = Number(arg('days', '30'));
// Shifts the whole window into the past: --days 90 --end-days-ago 90 tests the 90 days before the last 90, unseen by anything tuned on those
const endDaysAgo = Number(arg('end-days-ago', '0'));
if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(endDaysAgo) || endDaysAgo < 0) throw new Error('--days must be > 0 and --end-days-ago >= 0');
const equity = Number(arg('equity', '1150'));
const fundingEnabled = process.argv.includes('--funding');
const decisionsPath = arg('decisions', '');
// archive = data.binance.vision, for networks where fapi.binance.com is blocked (HTTP 451); it lags by about a day
const source = arg('source', 'api') as KlineSource;
if (!['api', 'archive'].includes(source)) throw new Error('--source must be api or archive');
const positionManagerArg = arg('position-manager', '');
if (positionManagerArg && !['on', 'off'].includes(positionManagerArg)) throw new Error('--position-manager must be on or off');

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function table(title: string, slices: Record<string, { trades: number; winRatePct: number; expectancyR: number | null; netPnl: number }>): void {
  console.log(`\n${title}`);
  console.log('  ' + 'key'.padEnd(20) + 'trades'.padEnd(8) + 'win%'.padEnd(7) + 'E[R]'.padEnd(9) + 'net PnL (after fees)');
  for (const [key, s] of Object.entries(slices)) {
    const expectancy = s.expectancyR === null ? '—' : s.expectancyR.toFixed(2);
    console.log('  ' + key.padEnd(20) + String(s.trades).padEnd(8) + String(s.winRatePct).padEnd(7) + expectancy.padEnd(9) + s.netPnl.toFixed(2));
  }
}

const toMs = Date.now() - endDaysAgo * 86_400_000;
const fromMs = toMs - days * 86_400_000;
console.log(`Backtesting ${symbol} over ${days} day(s) ending ${endDaysAgo === 0 ? 'now' : `${endDaysAgo} day(s) ago`} from public Binance USD-M klines...`);
const data: ReplayData = { [symbol]: {} };
for (const timeframe of TIMEFRAMES) {
  const { candles } = await loadValidatedKlines({ symbol, interval: timeframe, fromMs, toMs, source });
  data[symbol][timeframe] = candles;
  console.log(`  ${timeframe}: ${candles.length} candles (${new Date(candles[0]!.openTime).toISOString()} -> ${new Date(candles[candles.length - 1]!.openTime).toISOString()}), integrity gate passed`);
}

const service = new ReplayService({
  log: (line) => console.log(line),
  config: {
    initialEquity: equity,
    warmupBars: 300,
    funding: { enabled: fundingEnabled, intervalHours: 8, rate: 0.0001 },
    ...(decisionsPath ? { decisionsPath } : {}),
    ...(positionManagerArg ? { positionManager: positionManagerArg === 'on' } : {}),
  },
});

const result = await service.run(data);
const m = result.metrics;

console.log('\n=== Headline ===');
row('Total trades', `${m.totalTrades} (${result.partials.length} partial take-profit legs)`);
row('Win rate', `${m.winRatePct}%`);
row('Net PnL (after fees)', `${m.netPnl.toFixed(2)} USDT (${m.netReturnPct}%)`);
row('Gross price PnL', `${m.grossPnl.toFixed(2)} USDT`);
row('Final equity', `${m.finalEquity.toFixed(2)} USDT (from ${m.initialEquity})`);
row('Profit factor', m.profitFactor === null ? '∞' : String(m.profitFactor));
row('Expectancy', `${m.expectancyR ?? '—'} R / ${m.expectancyUsd?.toFixed(2) ?? '—'} USDT`);
row('Payoff ratio', m.payoffRatio === null ? '—' : String(m.payoffRatio));

console.log('\n=== Risk ===');
row('Max drawdown', `${m.maxDrawdownPct}% (${m.maxDrawdownUsd.toFixed(2)} USDT)`);
row('Sharpe / Sortino (ann.)', `${m.sharpe ?? '—'} / ${m.sortino ?? '—'}`);
row('CVaR 95%', m.cvar95Pct === null ? '—' : `${m.cvar95Pct}%`);
row('Max consecutive losses', String(m.maxConsecutiveLosses));
row('Largest win / loss', `${m.largestWinUsd.toFixed(2)} / ${m.largestLossUsd.toFixed(2)}`);
row('Liquidations', String(m.liquidations));

console.log('\n=== Behaviour ===');
row('Avg / max hold', `${m.avgHoldHours ?? '—'}h / ${m.maxHoldHours ?? '—'}h`);
row('Time in market', `${m.timeInMarketPct}%`);
row('Turnover (x equity)', String(m.turnover));
row('Fees paid', `${m.feesPaid.toFixed(2)} USDT`);
row('Funding paid', `${m.fundingPaid.toFixed(2)} USDT`);
row('Slippage paid', `${m.slippagePaid.toFixed(2)} USDT`);
if (m.maeR && m.mfeR) row('MAE / MFE (avg R)', `${m.maeR.avg} / ${m.mfeR.avg}`);

table('=== By strategy ===', m.byStrategy);
table('=== By regime ===', m.byRegime);
table('=== By evidence bucket ===', m.byEvidenceBucket);
table('=== By symbol ===', m.bySymbol);

console.log(`\nDecisions journaled: ${result.decisions.length} (${result.decisions.filter((d) => d.status === 'EXECUTED').length} executed, ${result.decisions.filter((d) => d.status !== 'EXECUTED').length} rejected/refused)`);
console.log(`Period: ${new Date(m.period.from).toISOString()} -> ${new Date(m.period.to).toISOString()} over ${m.period.steps} 15m steps`);
if (decisionsPath) console.log(`Decision journal written to ${decisionsPath}`);
