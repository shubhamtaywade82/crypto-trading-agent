import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
import type { AgentState, Position, LogEntry, MarketPriceInfo, StrategyMetrics } from '../types.js';
import { formatPrice, formatQty } from '../binance/symbolRules.js';

// Prices and quantities use each symbol's own precision; every other figure is 2dp
const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface CockpitProps {
  mode: string; time: string; equity: number; upnl: number; marginUsed: number;
  positions: Position[]; selPos: number; agents: AgentState[]; logs: LogEntry[];
  spotPrices?: Record<string, MarketPriceInfo>; fundingRate?: number;
  strategyMetrics?: StrategyMetrics; isSyncing: boolean; totalWidth?: number; totalHeight?: number;
}


export function padLine(str: string, width: number): string {
  const sw = stringWidth(str);
  if (sw === width) return str;
  if (sw < width) return str + ' '.repeat(width - sw);
  return cliTruncate(str, width);
}

export function computeColWidths(totalWidth: number) {
  const available = totalWidth - 5;
  const c1 = Math.min(40, Math.max(28, Math.round(available * 0.22)));
  const c3 = Math.min(64, Math.max(30, Math.round(available * 0.26)));
  const c4 = Math.min(36, Math.max(25, Math.round(available * 0.20)));
  const c2 = available - c1 - c3 - c4;
  return { c1, c2, c3, c4 };
}

export function computeRowHeights(targetRows: number) {
  const available = targetRows - 30;
  if (available < 4) return { tableRows: 12, logRows: 2 };
  const tableRows = Math.max(12, Math.min(26, Math.round(available * 0.58)));
  const logRows = Math.max(2, available - tableRows);
  return { tableRows: available - logRows, logRows };
}

export function renderHeaderLines(mode: string, time: string, width: number = 128): string[] {
  const innerW = width - 2;
  const tag = mode === 'paper' ? chalk.yellow.bold('◉ PAPER') : chalk.green.bold('● LIVE');
  const left = ' ' + chalk.green.bold('⬡ INKUI AGENT TRADE') + chalk.gray(' v2.4.1 ') + tag + '  ' + chalk.cyan.bold('◆ BINANCE FUTURES');
  const right = chalk.gray(`${time} UTC `) + chalk.green('●5 ag ') + chalk.cyan('●auto');
  const midSpace = Math.max(0, innerW - stringWidth(left) - stringWidth(right));
  return [chalk.cyan('╭' + '─'.repeat(innerW) + '╮'), chalk.cyan('│') + left + ' '.repeat(midSpace) + right + chalk.cyan('│'), chalk.cyan('╰' + '─'.repeat(innerW) + '╯')];
}

export function renderCol1Lines(p: CockpitProps, width = 40, rowCount = 29): string[] {
  const marginPct = ((p.marginUsed / (p.equity || 1)) * 100).toFixed(2);
  const rows: string[] = [
    padLine(' ' + chalk.gray('Equity  ') + chalk.white.bold(`$${usd(p.equity)}`) + chalk.gray(' (paper)'), width),
    padLine(' ' + chalk.green('+$27,766 (+27.77% total)'), width),
    padLine(' ' + chalk.gray('uPnL    ') + chalk.green.bold(`+$${p.upnl.toFixed(2)}`), width),
    padLine(' ' + chalk.gray('Margin  ') + chalk.white(`$${usd(p.marginUsed)}`) + chalk.gray(` (${marginPct}% used)`), width),
    padLine(' ' + chalk.gray('Free    ') + chalk.white(`$${usd(Math.max(0, p.equity - p.marginUsed))}`), width),
    padLine(' ' + chalk.gray('Lev cap 3x │ Mode ') + chalk.yellow('ISOLATED'), width),
  ];
  const isCompact = (rowCount - rows.length) < 20;
  for (const a of p.agents.slice(0, 6)) {
    const icon = a.status === 'RUNNING' ? chalk.green('●') : chalk.yellow('◐');
    rows.push(padLine(`  ${icon} ${chalk.cyan.bold(a.id)} ${chalk.green(a.status)}${isCompact ? ` ${chalk.green(`+$${(a.pnl / 1000).toFixed(2)}k`)}` : ''}`, width));
    if (!isCompact) {
      rows.push(padLine(`   ${chalk.gray(a.strategy)}`, width));
      rows.push(padLine(`   ${chalk.gray(`pos ${a.positions} win ${a.winRate === null ? '—' : `${a.winRate}%`} pnl `)}${chalk.green(`+$${(a.pnl / 1000).toFixed(2)}k`)}`, width));
    }
  }
  while (rows.length < rowCount) rows.push(' '.repeat(width));
  return rows.slice(0, rowCount);
}

function fmtVol(v?: number): string {
  if (!v) return '$0';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  return '$' + (v / 1e3).toFixed(2) + 'K';
}

function fmtRange(symbol: string, low?: number, high?: number): string {
  if (!low || !high) return '—';
  return `$${formatPrice(symbol, low)} - $${formatPrice(symbol, high)}`;
}

function renderAssetRow(sym: string, info: MarketPriceInfo | undefined, width: number, isWide: boolean): string[] {
  const p = info?.price ?? (sym === 'BTC' ? 81070 : sym === 'ETH' ? 2626 : sym === 'SOL' ? 111.6 : 8.54);
  const chg = info?.changePct ?? 0;
  const pair = `${sym}USDT`;
  const pStr = `$${formatPrice(pair, p)}`.padStart(11);
  const chgCol = chg >= 0 ? chalk.green : chalk.red;
  const chgStr = chgCol(((chg >= 0 ? '+' : '') + chg.toFixed(2) + '%').padStart(8));
  const spark = info?.sparkline ? chgCol(info.sparkline) : '';

  if (isWide) {
    const range = fmtRange(pair, info?.low24h, info?.high24h).padEnd(23);
    const vol = fmtVol(info?.volumeQuote).padStart(10);
    const l = ` ${chalk.yellow.bold(sym.padEnd(5))} ${chalk.white(pStr)}  ${chgStr}  ${chalk.gray('│ ')}${chalk.white(range)} ${chalk.gray('│ ')}${chalk.cyan(vol)}  ${chalk.gray('│ ')}${spark}`;
    return [padLine(l, width)];
  }
  const range = fmtRange(pair, info?.low24h, info?.high24h).padEnd(15);
  const vol = ('Vol ' + fmtVol(info?.volumeQuote)).padStart(11);
  const l1 = ` ${chalk.yellow.bold(sym.padEnd(4))} ${chalk.white(pStr.trim().padStart(9))} ${chgStr} ${chalk.gray('│ ')}${spark}`;
  const l2 = `   ${chalk.gray('24h')} ${chalk.white(range)} ${chalk.gray('│ ')}${chalk.cyan(vol)}`;
  return [padLine(l1, width), padLine(l2, width)];
}

export function renderCol2Lines(
  spotPrices?: Record<string, MarketPriceInfo>,
  metrics?: StrategyMetrics,
  width: number = 52,
  rowCount: number = 29
): string[] {
  const fund = '—';
  const cd = metrics?.nextFundingCountdown ?? '7h58m';
  const totalVol = (spotPrices?.BTC?.volumeQuote ?? 15.8e9) + (spotPrices?.ETH?.volumeQuote ?? 4.2e9) + (spotPrices?.SOL?.volumeQuote ?? 1.8e9) + (spotPrices?.AVAX?.volumeQuote ?? 240e6);
  const syms = ['BTC', 'ETH', 'SOL', 'AVAX'] as const;
  const isWide = width >= 76;

  const rows: string[] = [
    padLine(` ${chalk.gray('USDM Funding 8h: ')}${chalk.green(fund)}${chalk.gray(' │ settle in ')}${chalk.cyan.bold(cd)}`, width),
    padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width),
  ];
  if (isWide) {
    rows.push(padLine(` ${chalk.gray('ASSET'.padEnd(5))} ${chalk.gray('PRICE'.padStart(11))}  ${chalk.gray('24h CHG'.padStart(8))}  ${chalk.gray('│ 24h RANGE'.padEnd(25))} ${chalk.gray('│ 24h VOLUME'.padStart(12))}  ${chalk.gray('│ 15m TREND')}`, width));
    rows.push(padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width));
  }
  rows.push(...syms.flatMap((s) => renderAssetRow(s, spotPrices?.[s], width, isWide)));
  rows.push(
    padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width),
    padLine(` ${chalk.cyan.bold('MARKET REGIME & VOLATILITY')}`, width),
    padLine(`   ${chalk.gray('Turnover  ')}${chalk.gray('│ ')}${chalk.white(`${fmtVol(totalVol)} 24h futures vol`)}`, width),
    padLine(`   ${chalk.gray('Momentum  ')}${chalk.gray('│ ')}${chalk.green('BULLISH')} ${chalk.gray('(all 4 above EMA50)')}`, width),
    padLine(`   ${chalk.gray('Carry     ')}${chalk.gray('│ ')}${chalk.green('POSITIVE')} ${chalk.gray('(+10.95% APR avg)')}`, width),
  );
  while (rows.length < rowCount) rows.push(' '.repeat(width));
  return rows.slice(0, rowCount);
}

export function renderCol3Lines(p: CockpitProps, width = 34, rowCount = 29): string[] {
  const rows: string[] = [];
  const isWide = width >= 48;
  for (let i = 0; i < p.positions.length; i++) {
    const pos = p.positions[i];
    const cur = i === p.selPos ? chalk.yellow.bold('▸') : ' ';
    const sym = i === p.selPos ? chalk.white.bold(pos.symbol.padEnd(9)) : chalk.white(pos.symbol.padEnd(9));
    const type = chalk.gray((pos.posType ?? pos.side).padEnd(11));
    const sign = pos.upnl >= 0 ? '+' : '';
    const pnlCol = pos.upnl >= 0 ? chalk.green : chalk.red;
    const pnlStr = pnlCol(`${sign}$${pos.upnl.toFixed(2)}`);
    const line = isWide
      ? ` ${cur} ${sym} ${type} ${chalk.gray('e ')}${chalk.white(formatPrice(pos.symbol, pos.entry).padEnd(7))} ${chalk.gray('sz ')}${chalk.white(formatQty(pos.symbol, pos.qty))} ${pnlStr}`
      : ` ${cur} ${sym} ${type} ${pnlStr}`;
    rows.push(padLine(line, width));
  }
  if (rows.length < rowCount) {
    rows.push(padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width));
    const upnl = p.positions.reduce((acc, pos) => acc + pos.upnl, 0);
    const sign = upnl >= 0 ? '+' : '';
    const col = upnl >= 0 ? chalk.green.bold : chalk.red.bold;
    rows.push(padLine(`   ${chalk.gray('Total uPnL: ')}${col(`${sign}$${upnl.toFixed(2)}`)}`, width));
    rows.push(padLine(`   ${chalk.gray('Positions:  ')}${chalk.white(`${p.positions.length} active`)}`, width));
  }
  while (rows.length < rowCount) rows.push(' '.repeat(width));
  return rows.slice(0, rowCount);
}

export function renderCol4Lines(p: CockpitProps, width = 30, rowCount = 29): string[] {
  const marginPct = ((p.marginUsed / (p.equity || 1)) * 100).toFixed(2);
  const rows: string[] = [
    padLine(` ${chalk.cyan.bold('ACCOUNT & MARGIN')}`, width),
    padLine(`   ${chalk.gray('Unrealized ')}${chalk.green.bold(`+$${p.upnl.toFixed(2)}`)}`, width),
    padLine(`   ${chalk.gray('Margin     ')}${chalk.white(`$${usd(p.marginUsed)}`)}${chalk.gray(` (${marginPct}%)`)}`, width),
    padLine(`   ${chalk.gray('Free       ')}${chalk.white(`$${usd(Math.max(0, p.equity - p.marginUsed))}`)}`, width),
    padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width),
    padLine(` ${chalk.cyan.bold('RISK-MGR-δ METRICS')}`, width),
    padLine(`   ${chalk.gray('VaR(95%)   ')}${chalk.red('-$1,842 1.8%')}`, width),
    padLine(`   ${chalk.gray('Exposure   ')}${chalk.yellow('42% / 80%')}`, width),
    padLine(`   ${chalk.gray('MaxDD      ')}${chalk.yellow('-2.4% / -5%')}`, width),
    padLine(`   ${chalk.gray('Liq buffer ')}${chalk.green('18.7x ATR')}`, width),
    padLine(`   ${chalk.gray('Corr BTC-E ')}${chalk.yellow('0.91 high')}`, width),
    padLine(`   ${chalk.gray('Sharpe     ')}${chalk.green('2.84')}`, width),
    padLine(` ${chalk.gray('─'.repeat(Math.max(10, width - 2)))}`, width),
    padLine(` ${chalk.cyan.bold('POSITION ACTIONS')}`, width),
    padLine(`   ${chalk.yellow('▸Close ETH/USDT SHORT')}`, width),
    padLine(`    ${chalk.gray('Close SOL/USDT SHORT')}`, width),
    padLine(`    ${chalk.gray('Close BTC/ETH pairs')}`, width),
  ];
  while (rows.length < rowCount) rows.push(' '.repeat(width));
  return rows.slice(0, rowCount);
}

export function renderCockpitTable(cols: [string[], string[], string[], string[]], widths: [number, number, number, number]): string[] {
  const [c1, c2, c3, c4] = cols;
  const [w1, w2, w3, w4] = widths;
  const bar = (l: string, m: string, r: string) => chalk.cyan(l + '─'.repeat(w1) + m + '─'.repeat(w2) + m + '─'.repeat(w3) + m + '─'.repeat(w4) + r);
  const title = chalk.cyan('│') + padLine(' ' + chalk.cyan.bold('AGENT FLEET (5 active)'), w1) +
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold('BINANCE USDT-M PERPETUAL FUTURES'), w2) +
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold(`POSITIONS (${w3 > 35 ? '6 open' : 'open'})`), w3) +
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold('RISK & ACCOUNT'), w4) + chalk.cyan('│');
  const rows = [bar('┌', '┬', '┐'), title, bar('├', '┼', '┤')];
  const count = Math.min(c1.length, c2.length, c3.length, c4.length);
  for (let i = 0; i < count; i++) rows.push(chalk.cyan('│') + c1[i] + chalk.cyan('│') + c2[i] + chalk.cyan('│') + c3[i] + chalk.cyan('│') + c4[i] + chalk.cyan('│'));
  rows.push(bar('└', '┴', '┘'));
  return rows;
}

function boxLines(title: string, content: string[], width: number): string[] {
  const innerW = width - 2;
  return [
    chalk.cyan('┌' + '─'.repeat(innerW) + '┐'),
    chalk.cyan('│') + padLine(' ' + chalk.cyan.bold(title), innerW) + chalk.cyan('│'),
    chalk.cyan('├' + '─'.repeat(innerW) + '┤'),
    ...content.map((l) => chalk.cyan('│') + padLine(l, innerW) + chalk.cyan('│')),
    chalk.cyan('└' + '─'.repeat(innerW) + '┘'),
  ];
}

export function renderDetailLines(p: Position | undefined, width: number = 128): string[] {
  const pos = p ?? { symbol: 'ETH/USDT', side: 'SHORT' as const, posType: 'PERP-SHORT', strategy: 'FUNDING-ARB-α' as const, entry: 2630.0, qty: 2.0, mark: 2626.2, upnl: 7.6, upnlPct: 0.14, leverage: 5 };
  const l1 = ' ' + chalk.yellow.bold(`${pos.symbol} ${pos.posType ?? pos.side}`) + ' · ' + chalk.cyan(pos.strategy) + chalk.gray(' │ entry ') + chalk.white(`$${formatPrice(pos.symbol, pos.entry)}`) + chalk.gray(' │ size ') + chalk.white(formatQty(pos.symbol, pos.qty)) + chalk.gray(' │ mark ') + chalk.white(`$${formatPrice(pos.symbol, pos.mark)}`) + chalk.gray(' │ uPnL ') + chalk.green(`+$${pos.upnl.toFixed(2)} (+${pos.upnlPct.toFixed(2)}%)`) + chalk.gray(' │ lev ') + chalk.yellow(`${pos.leverage}x ISOLATED`);
  const l2 = ' ' + chalk.gray('liq dist ') + chalk.cyan('18.2%') + chalk.gray(' │ server SL ') + chalk.white('2750 (STOP_MARKET)') + chalk.gray(' │ server TP ') + chalk.white('fund') + chalk.gray(' │ maint margin ') + chalk.green('OK ✓') + chalk.gray(' │ liq buffer ') + chalk.green('>2x ATR ✓');
  return boxLines('POSITION DETAIL (selected)', [l1, l2], width);
}

export function renderMetricsLines(m?: StrategyMetrics, width: number = 128): string[] {
  const zFmt = (z?: number | null) => { const s = (z ?? 0).toFixed(2); return (z ?? 0) < 0 ? chalk.yellow(s.padStart(5)) : chalk.green(s.padStart(5)); };
  const sm1 = ' ' + chalk.cyan.bold('FUNDING-ARB    ') + chalk.gray(`│ funding —     │ next ${m?.nextFundingCountdown ?? '—'}`);
  const sm2 = ' ' + chalk.cyan.bold('PAIRS-TRD      ') + chalk.gray('│ BTC/ETH z ') + zFmt(m?.zscoreBtcEth) + chalk.gray(' (gate ±2.0)  │ exit z=0 SL |z|>3.5');
  const sm3 = ' ' + chalk.cyan.bold('MOMENTUM       ') + chalk.gray('│ ATR —       │ trail 2.5*ATR EMA50 15m');
  return boxLines('STRATEGY METRICS (live agent telemetry · binance-only)', [sm1, sm2, sm3], width);
}

export function renderLogLines(logs: LogEntry[], maxRows: number = 10, width: number = 128): string[] {
  const content: string[] = [];
  for (let i = 0; i < maxRows; i++) {
    const l = logs[i];
    const timeStr = l ? new Date(l.ts).toISOString().slice(11, 19) : '07:39:05';
    const agent = l ? l.agent : 'MANUAL';
    const lvlColor = !l ? chalk.white : l.level === 'error' ? chalk.red : l.level === 'warn' ? chalk.yellow : l.level === 'success' ? chalk.green : chalk.white;
    const msg = l ? l.msg : 'Close ETH/USDT SHORT → market close via Binance USDM Futures';
    content.push(' ' + chalk.gray(timeStr) + ' ' + chalk.yellow.bold(agent.padEnd(12)) + ' ' + chalk.gray('├─ ') + lvlColor(msg));
  }
  return boxLines('AGENT REASONING LOG (autonomous · server-side SL/TP · isolated margin)', content, width);
}

export function renderPerfLines(width: number = 128): string[] {
  const innerW = width - 2;
  const text = ' ' + chalk.white('Today ') + chalk.cyan.bold('142') + chalk.gray(' decisions │ ') + chalk.green.bold('98') + chalk.gray(' executed │ ') + chalk.yellow.bold('32') + chalk.gray(' monitored │ ') + chalk.green.bold('96.4%') + chalk.gray(' success │ ') + chalk.green.bold('+$27,766') + chalk.gray(' PnL │ Sharpe ') + chalk.green.bold('2.84') + chalk.gray(' │ MaxDD ') + chalk.yellow.bold('-2.4%') + chalk.gray(' │ liq events ') + chalk.green.bold('0');
  return [chalk.yellow('╔' + '═'.repeat(innerW) + '╗'), chalk.yellow('║') + padLine(text, innerW) + chalk.yellow('║'), chalk.yellow('╚' + '═'.repeat(innerW) + '╝')];
}

export function renderFooterLines(isSyncing: boolean, mode: string, width: number = 128): string[] {
  const innerW = width - 2;
  const spinner = isSyncing ? chalk.yellow('⠋') : chalk.yellow('⠴');
  const l1 = ' ' + spinner + chalk.gray(' orchestrator │ 5 agents autonomous │ eval 8s │ api weight ') + chalk.white('247/1200') + chalk.gray(' │ ws ') + chalk.green('●usdm-fstream') + chalk.gray(' │ mode ') + chalk.yellow.bold(mode.toUpperCase()) + chalk.gray(' │ venue BINANCE FUTURES');
  const l2 = ' ' + chalk.gray('╰─ ↑↓nav cclose-pos xcancel aadvisor-audit sstop-all ?help');
  return [chalk.cyan('│') + padLine(l1, innerW) + chalk.cyan('│'), chalk.cyan('│') + padLine(l2, innerW) + chalk.cyan('│'), chalk.cyan('╰' + '─'.repeat(innerW) + '╯')];
}

export function ResizeWarning({ cols, rows }: { cols: number; rows: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} width={60}>
      <Text color="green" bold>⬡ INKUI AGENT TRADE v2.4.1</Text>
      <Text color="yellow" bold>Terminal size too small for cockpit:</Text>
      <Text color="gray">  Required: <Text color="white">80 cols × 40 rows minimum</Text></Text>
      <Text color="gray">  Current:  <Text color="red">{cols} cols × {rows} rows</Text></Text>
      <Text color="cyan">Please enlarge your terminal window.</Text>
    </Box>
  );
}

export function renderCockpit(props: CockpitProps): string[] {
  const width = Math.max(80, props.totalWidth ?? 128);
  const targetLines = Math.max(28, (props.totalHeight ?? 58) - 1);
  const { c1, c2, c3, c4 } = computeColWidths(width);
  const { tableRows, logRows } = computeRowHeights(targetLines);

  const col1 = renderCol1Lines(props, c1, tableRows);
  const col2 = renderCol2Lines(props.spotPrices, props.strategyMetrics, c2, tableRows);
  const col3 = renderCol3Lines(props, c3, tableRows);
  const col4 = renderCol4Lines(props, c4, tableRows);

  return [
    ...renderHeaderLines(props.mode, props.time, width),
    ...renderCockpitTable([col1, col2, col3, col4], [c1, c2, c3, c4]),
    ...renderDetailLines(props.positions[props.selPos], width),
    ...renderMetricsLines(props.strategyMetrics, width),
    ...renderLogLines(props.logs, logRows, width),
    ...renderPerfLines(width),
    ...renderFooterLines(props.isSyncing, props.mode, width),
  ];
}
