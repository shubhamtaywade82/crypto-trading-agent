/**
 * Backtest CLI — replays the full decision pipeline over public Binance klines.
 *
 *   npx tsx scripts/backtest.ts [--symbol BTCUSDT] [--days 30] [--equity 1150]
 *                                [--funding] [--decisions data/backtest-decisions.jsonl]
 *                                [--position-manager on|off]
 *
 * Fetches public USD-M klines (15m/1h/4h — the timeframes the state layer
 * consumes), then runs the same agents, fusion, risk gate and execution model
 * the orchestrator runs, on a no-lookahead feed with spread, slippage, taker
 * fees and conservative intrabar exits.
 */
import { ReplayService } from '../src/backtesting/ReplayService.js';
import type { Candle } from '../src/types.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';
import type { ReplayData } from '../src/backtesting/types.js';

const BASE = 'https://fapi.binance.com';
const INTERVAL_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const TIMEFRAMES: NativeTimeframe[] = ['15m', '1h', '4h'];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const symbol = arg('symbol', 'BTCUSDT').toUpperCase();
const days = Number(arg('days', '30'));
const equity = Number(arg('equity', '1150'));
const fundingEnabled = process.argv.includes('--funding');
const decisionsPath = arg('decisions', '');
const positionManagerArg = arg('position-manager', '');
if (positionManagerArg && !['on', 'off'].includes(positionManagerArg)) throw new Error('--position-manager must be on or off');

async function fetchKlines(symbol: string, interval: NativeTimeframe, fromMs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = fromMs;
  for (;;) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1500`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`klines ${interval} failed: HTTP ${response.status}`);
    const raw = (await response.json()) as unknown[][];
    for (const k of raw) {
      out.push({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) });
    }
    if (raw.length < 1500) break;
    cursor = Number(raw[raw.length - 1][0]) + INTERVAL_MS[interval];
  }
  return out;
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function table(title: string, slices: Record<string, { trades: number; winRatePct: number; expectancyR: number | null; netPnl: number }>): void {
  console.log(`\n${title}`);
  console.log('  ' + 'key'.padEnd(20) + 'trades'.padEnd(8) + 'win%'.padEnd(7) + 'E[R]'.padEnd(9) + 'net PnL');
  for (const [key, s] of Object.entries(slices)) {
    const expectancy = s.expectancyR === null ? '—' : s.expectancyR.toFixed(2);
    console.log('  ' + key.padEnd(20) + String(s.trades).padEnd(8) + String(s.winRatePct).padEnd(7) + expectancy.padEnd(9) + s.netPnl.toFixed(2));
  }
}

const fromMs = Date.now() - days * 86_400_000;
console.log(`Backtesting ${symbol} over the last ${days} day(s) from public Binance USD-M klines...`);
const data: ReplayData = { [symbol]: {} };
for (const timeframe of TIMEFRAMES) {
  const candles = await fetchKlines(symbol, timeframe, fromMs);
  data[symbol][timeframe] = candles;
  console.log(`  ${timeframe}: ${candles.length} candles (${new Date(candles[0].openTime).toISOString()} -> ${new Date(candles[candles.length - 1].openTime).toISOString()})`);
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
row('Net PnL', `${m.netPnl.toFixed(2)} USDT (${m.netReturnPct}%)`);
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
