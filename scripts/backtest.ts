/**
 * Unified Backtest CLI — replays the full decision pipeline over Binance klines.
 *
 *   npx tsx scripts/backtest.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT|all]
 *                               [--days 30] [--end-days-ago 0] [--equity 1150]
 *                               [--funding] [--position-manager on|off] [--source api|archive]
 *                               [--report [path]] [--no-report] [--decisions <path>] [--help]
 *
 * Replays public USD-M klines (15m/1h/4h) across one or multiple symbols through the
 * identical agent fleet, fusion, risk gate, and execution model used by the live bot.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ReplayService } from '../src/backtesting/ReplayService.js';
import type { NativeTimeframe } from '../src/market/MarketDataTypes.js';
import type { ReplayData } from '../src/backtesting/types.js';
import type { BacktestMetrics, MetricsSlice } from '../src/backtesting/BacktestMetrics.js';
import { loadValidatedKlines, type KlineSource } from '../src/backtesting/klineLoader.js';
import {
  buildRunId,
  describeSeries,
  readCodeState,
  resolveResearchWindow,
  writeRunManifest,
  type SeriesRecord,
} from '../src/backtesting/researchRun.js';

const TIMEFRAMES: NativeTimeframe[] = ['15m', '1h', '4h'];
const DEFAULT_ALL_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1]?.startsWith('--')
    ? process.argv[index + 1]!
    : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function printHelp(): void {
  console.log(`
Unified Backtest CLI — Replays the live trading engine over Binance klines.

Usage:
  npm run backtest -- [options]

Options:
  --symbols <list|all>        Symbols to simulate (e.g. BTCUSDT,ETHUSDT or all; default: BTCUSDT)
  --days <number>             Window duration in days (default: 30)
  --end-days-ago <number>     Shift window into past for OOS testing (default: 0)
  --equity <usd>              Starting capital in USDT (default: 1150)
  --funding                   Account for 8h funding rate settlements
  --position-manager <on|off> Dynamic trailing/breakeven exits (default: on)
  --source <api|archive>      Binance API or Vision archive (default: api)
  --report [path]             Save Markdown report to reports/ (or custom path)
  --no-report                 Disable Markdown report generation
  --decisions <path>          Write execution decision log to JSONL file
  --help, -h                  Display this help message

Examples:
  npm run backtest -- --symbols all --days 30 --report
  npm run backtest -- --symbols BTCUSDT,ETHUSDT --days 60 --end-days-ago 30
`);
}

function parseSymbols(): string[] {
  const rawSymbols = arg('symbols', '');
  const rawSingle = arg('symbol', '');
  if (rawSymbols.toLowerCase() === 'all') return DEFAULT_ALL_SYMBOLS;
  if (rawSymbols) return rawSymbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (rawSingle) return [rawSingle.trim().toUpperCase()];
  return ['BTCUSDT'];
}

function calculateBenchmark(data: ReplayData, symbols: string[]): number {
  let totalRet = 0;
  let count = 0;
  for (const sym of symbols) {
    const candles = data[sym]?.['15m'];
    if (!candles || candles.length === 0) continue;
    const openPx = candles[0].open;
    const closePx = candles[candles.length - 1].close;
    if (openPx > 0) {
      totalRet += ((closePx - openPx) / openPx) * 100;
      count += 1;
    }
  }
  return count > 0 ? totalRet / count : 0;
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function table(title: string, slices: Record<string, MetricsSlice>): void {
  console.log(`\n${title}`);
  console.log('  ' + 'key'.padEnd(24) + 'trades'.padEnd(8) + 'win%'.padEnd(7) + 'E[R]'.padEnd(9) + 'net PnL (USDT)');
  for (const [key, s] of Object.entries(slices)) {
    const expectancy = s.expectancyR === null ? '—' : s.expectancyR.toFixed(2);
    console.log('  ' + key.padEnd(24) + String(s.trades).padEnd(8) + String(s.winRatePct).padEnd(7) + expectancy.padEnd(9) + s.netPnl.toFixed(2));
  }
}

function toMarkdownTable(title: string, slices: Record<string, MetricsSlice>): string {
  const lines = [`\n### ${title}`, '| Key | Trades | Win Rate | Expectancy (R) | Net PnL (USDT) |', '| :--- | ---: | ---: | ---: | ---: |'];
  for (const [key, s] of Object.entries(slices)) {
    const exp = s.expectancyR === null ? '—' : s.expectancyR.toFixed(2);
    lines.push(`| \`${key}\` | ${s.trades} | ${s.winRatePct}% | ${exp}R | ${s.netPnl.toFixed(2)} |`);
  }
  return lines.join('\n');
}

function buildMarkdownReport(p: {
  runId: string;
  symbols: string[];
  days: number;
  windowStr: string;
  m: BacktestMetrics;
  benchmarkPct: number;
  partialsCount: number;
}): string {
  const { runId, symbols, days, windowStr, m, benchmarkPct, partialsCount } = p;
  const alpha = m.netReturnPct - benchmarkPct;
  const feeDrag = m.grossPnl > 0 ? (((m.feesPaid + m.slippagePaid + m.fundingPaid) / m.grossPnl) * 100).toFixed(1) : '—';
  return [
    `# Backtest Report: ${runId}`,
    `\n- **Window:** ${windowStr} (${days} days)`,
    `- **Symbols:** ${symbols.join(', ')}`,
    `- **Generated:** ${new Date().toISOString()}`,
    '\n## Headline Performance',
    '| Metric | Value |',
    '| :--- | :--- |',
    `| **Net Return** | **${m.netReturnPct.toFixed(2)}%** (${m.netPnl.toFixed(2)} USDT) |`,
    `| **Benchmark Return (Equal-Weight B&H)** | ${benchmarkPct.toFixed(2)}% |`,
    `| **Alpha (Excess vs Benchmark)** | **${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%** |`,
    `| **Total Trades** | ${m.totalTrades} (${partialsCount} partial take-profits) |`,
    `| **Win Rate** | ${m.winRatePct}% |`,
    `| **Gross Price PnL** | ${m.grossPnl.toFixed(2)} USDT |`,
    `| **Final Equity** | ${m.finalEquity.toFixed(2)} USDT (Initial: ${m.initialEquity}) |`,
    `| **Profit Factor** | ${m.profitFactor === null ? '∞' : m.profitFactor} |`,
    `| **Expectancy** | ${m.expectancyR === null ? '—' : m.expectancyR.toFixed(2)} R / ${m.expectancyUsd?.toFixed(2) ?? '—'} USDT |`,
    `| **Max Drawdown** | ${m.maxDrawdownPct}% (${m.maxDrawdownUsd.toFixed(2)} USDT) |`,
    `| **Sharpe / Sortino** | ${m.sharpe ?? '—'} / ${m.sortino ?? '—'} |`,
    `| **Friction / Fee Drag** | ${feeDrag}% of gross profits (${(m.feesPaid + m.slippagePaid + m.fundingPaid).toFixed(2)} USDT) |`,
    toMarkdownTable('By Symbol', m.bySymbol),
    toMarkdownTable('By Strategy', m.byStrategy),
    toMarkdownTable('By Regime', m.byRegime),
    toMarkdownTable('By Evidence Bucket', m.byEvidenceBucket),
  ].join('\n');
}

async function loadMultiSeries(symbols: string[], fromMs: number, toMs: number, source: KlineSource) {
  const data: ReplayData = {};
  const series: SeriesRecord[] = [];
  for (const sym of symbols) {
    data[sym] = {};
    for (const timeframe of TIMEFRAMES) {
      const loaded = await loadValidatedKlines({ symbol: sym, interval: timeframe, fromMs, toMs, source });
      data[sym][timeframe] = loaded.candles;
      series.push(describeSeries({ symbol: sym, interval: timeframe, source, window: loaded.window, candles: loaded.candles }));
      console.log(`  [${sym}] ${timeframe}: ${loaded.candles.length} candles, integrity gate passed`);
    }
  }
  return { data, series };
}

if (hasFlag('help') || hasFlag('h')) {
  printHelp();
  process.exit(0);
}

const symbols = parseSymbols();
const days = Number(arg('days', '30'));
const endDaysAgo = Number(arg('end-days-ago', '0'));
const equity = Number(arg('equity', '1150'));
const fundingEnabled = hasFlag('funding');
const decisionsPath = arg('decisions', '');
const reportCustomPath = arg('report', '');
const reportEnabled = !hasFlag('no-report');
const source = arg('source', 'api') as KlineSource;
if (!['api', 'archive'].includes(source)) throw new Error('--source must be api or archive');
const positionManagerArg = arg('position-manager', '');
if (positionManagerArg && !['on', 'off'].includes(positionManagerArg)) throw new Error('--position-manager must be on or off');

const runNowMs = Date.now();
const runWindow = resolveResearchWindow({ days, endDaysAgo, source, nowMs: runNowMs });
const { fromMs, toMs } = runWindow;
const symLabel = symbols.length > 2 ? `${symbols.length}symbols` : symbols.join('-');
console.log(`Backtesting ${symbols.join(', ')} over ${runWindow.fromIso} -> ${runWindow.toIso} (${days} day(s), ${source})...`);

const { data, series } = await loadMultiSeries(symbols, fromMs, toMs, source);
const benchmarkPct = calculateBenchmark(data, symbols);

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
const alpha = m.netReturnPct - benchmarkPct;

console.log('\n=== Headline ===');
row('Net return', `${m.netReturnPct.toFixed(2)}% (${m.netPnl.toFixed(2)} USDT)`);
row('Benchmark (Buy & Hold)', `${benchmarkPct.toFixed(2)}%`);
row('Alpha vs Benchmark', `${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`);
row('Total trades', `${m.totalTrades} (${result.partials.length} partial take-profit legs)`);
row('Win rate', `${m.winRatePct}%`);
row('Gross price PnL', `${m.grossPnl.toFixed(2)} USDT`);
row('Final equity', `${m.finalEquity.toFixed(2)} USDT (from ${m.initialEquity})`);
row('Profit factor', m.profitFactor === null ? '∞' : String(m.profitFactor));
row('Expectancy', `${m.expectancyR !== null ? m.expectancyR.toFixed(2) : '—'} R / ${m.expectancyUsd?.toFixed(2) ?? '—'} USDT`);

console.log('\n=== Risk ===');
row('Max drawdown', `${m.maxDrawdownPct}% (${m.maxDrawdownUsd.toFixed(2)} USDT)`);
row('Sharpe / Sortino (ann.)', `${m.sharpe ?? '—'} / ${m.sortino ?? '—'}`);
row('CVaR 95%', m.cvar95Pct === null ? '—' : `${m.cvar95Pct}%`);
row('Max consecutive losses', String(m.maxConsecutiveLosses));
row('Largest win / loss', `${m.largestWinUsd.toFixed(2)} / ${m.largestLossUsd.toFixed(2)}`);
row('Liquidations', String(m.liquidations));

console.log('\n=== Behaviour & Costs ===');
row('Avg / max hold', `${m.avgHoldHours ?? '—'}h / ${m.maxHoldHours ?? '—'}h`);
row('Time in market', `${m.timeInMarketPct}%`);
row('Turnover (x equity)', String(m.turnover));
row('Fees paid', `${m.feesPaid.toFixed(2)} USDT`);
row('Funding paid', `${m.fundingPaid.toFixed(2)} USDT`);
row('Slippage paid', `${m.slippagePaid.toFixed(2)} USDT`);
if (m.maeR && m.mfeR) row('MAE / MFE (avg R)', `${m.maeR.avg} / ${m.mfeR.avg}`);

table('=== By Symbol ===', m.bySymbol);
table('=== By Strategy ===', m.byStrategy);
table('=== By Regime ===', m.byRegime);
table('=== By Evidence Bucket ===', m.byEvidenceBucket);

console.log(`\nDecisions journaled: ${result.decisions.length} (${result.decisions.filter((d) => d.status === 'EXECUTED').length} executed, ${result.decisions.filter((d) => d.status !== 'EXECUTED').length} rejected/refused)`);
console.log(`Period: ${new Date(m.period.from).toISOString()} -> ${new Date(m.period.to).toISOString()} over ${m.period.steps} 15m steps`);

const runId = buildRunId('backtest', `${symLabel}-${days}d-${source}`, runNowMs);
const { commit, dirty } = readCodeState(process.cwd());
const manifestPath = writeRunManifest({
  schemaVersion: 1,
  runId,
  kind: 'backtest',
  createdAtIso: new Date(runNowMs).toISOString(),
  codeCommit: commit,
  codeDirty: dirty,
  argv: process.argv.slice(2),
  window: runWindow,
  series,
  summary: {
    symbol: symbols.join(','),
    trades: m.totalTrades,
    netPnlUsdt: m.netPnl,
    netReturnPct: m.netReturnPct,
    maxDrawdownPct: m.maxDrawdownPct,
    decisionsJournal: decisionsPath || null,
  },
}, path.resolve('data/research/runs'));
console.log(`Run manifest written to ${manifestPath}`);

if (reportEnabled) {
  const resolvedReportPath = reportCustomPath || path.resolve(`reports/${runId}.report.md`);
  mkdirSync(path.dirname(resolvedReportPath), { recursive: true });
  const mdContent = buildMarkdownReport({
    runId,
    symbols,
    days,
    windowStr: `${runWindow.fromIso} -> ${runWindow.toIso}`,
    m,
    benchmarkPct,
    partialsCount: result.partials.length,
  });
  writeFileSync(resolvedReportPath, mdContent);
  console.log(`Markdown report written to ${resolvedReportPath}`);
}
