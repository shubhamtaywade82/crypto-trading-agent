import chalk from 'chalk';
import stringWidth from 'string-width';
import { config, LOOP_INTERVAL_MS } from '../config.js';
import { formatPrice, formatQty } from '../binance/symbolRules.js';
import type { AgentState, Position, WsStatus } from '../types.js';
import { coloredPnl, dp, fmtCurrency, fmtSignedCurrency, orDash, padLine, pnlColor, rule, runningCount, signedDp, signedUsd } from './format.js';
import type { CockpitProps } from './panels.js';

const API_WEIGHT_LIMIT = 2400; // Binance USD-M request-weight ceiling per minute
const WIN_BAR_CELLS = 12;
const AGENT_BLOCK_ROWS = 4;
const HIGH_CORRELATION = 0.8;
const MEDIUM_CORRELATION = 0.5;
const MAX_ACTION_ROWS = 3;
const MAX_FLEET_AGENTS = 10;
const WS_COLOR: Record<WsStatus, (text: string) => string> = { connected: chalk.green, reconnecting: chalk.yellow, down: chalk.red };
const VENUE_COLOR = { connected: chalk.green, degraded: chalk.yellow, down: chalk.red };

const separator = (width: number) => padLine(` ${chalk.gray(rule('─', Math.max(10, width - 2)))}`, width);
const blank = (width: number) => rule(' ', width);
const fillRows = (rows: string[], width: number, rowCount: number) => {
  while (rows.length < rowCount) rows.push(blank(width));
  return rows.slice(0, rowCount);
};
const marginPct = (p: CockpitProps) => dp(p.equity > 0 ? (p.marginUsed / p.equity) * 100 : 0);
const freeMargin = (p: CockpitProps) => Math.max(0, p.equity - p.marginUsed);

// Derived from equity so the equity line and the PnL line can never disagree between loops; null until a baseline exists
function pnlSinceStart(p: CockpitProps): { usd: number; pct: number } | null {
  if (p.initialEquity <= 0) return null;
  const change = p.equity - p.initialEquity;
  return { usd: change, pct: (change / p.initialEquity) * 100 };
}

export function renderHeaderLines(p: CockpitProps, width: number = 128): string[] {
  const innerW = width - 2;
  const tag = p.mode === 'paper' ? chalk.yellow.bold('◉ PAPER') : chalk.green.bold('● LIVE');
  const venueTitle = p.venue?.name?.startsWith('CoinDCX') ? '◆ COINDCX FUTURES' : '◆ BINANCE FUTURES';
  const left = ' ' + chalk.green.bold('⬡ NEMESIS CRYPTO AGENT') + chalk.gray(' v2.4.1 ') + tag + '  ' + chalk.cyan.bold(venueTitle);
  const timeDisplay = p.localTime && p.localTime !== `${p.time} UTC` ? `${p.time} UTC │ ${p.localTime}` : `${p.time} UTC`;
  const right = chalk.gray(`${timeDisplay} `) + chalk.green(`●${runningCount(p.agents)} ag `) + chalk.cyan('●auto');
  const midSpace = Math.max(0, innerW - stringWidth(left) - stringWidth(right));
  return [chalk.cyan('╭' + rule('─', innerW) + '╮'), chalk.cyan('│') + padLine(left + rule(' ', midSpace) + right, innerW) + chalk.cyan('│'), chalk.cyan('╰' + rule('─', innerW) + '╯')];
}

function winBar(winRate: number | null): string {
  const filled = winRate === null ? 0 : Math.min(WIN_BAR_CELLS, Math.max(0, Math.round((winRate / 100) * WIN_BAR_CELLS)));
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(WIN_BAR_CELLS - filled));
}

// Sliced rather than cli-truncated: a truncation ellipsis is exactly what the column floors are sized to avoid; the status word is never cut
function noteSuffix(note: string | undefined, room: number): string {
  const fitting = (note ?? '').slice(0, Math.max(0, room - 1));
  return fitting === '' ? '' : ' ' + chalk.yellow(fitting);
}

function agentRows(a: AgentState, isFull: boolean, width: number): string[] {
  const isRunning = a.status === 'RUNNING';
  const win = orDash(a.winRate, (rate) => `${dp(rate)}%`);
  const mult = a.edgeMultiplier ? ` ${chalk.magenta(`×${a.edgeMultiplier.toFixed(2)}`)}` : '';
  const title = `  ${isRunning ? chalk.green('●') : chalk.yellow('◐')} ${chalk.cyan.bold(a.id)} ${isRunning ? chalk.green(a.status) : chalk.yellow(a.status)}${mult}`;
  const head = padLine(title + noteSuffix(a.note, width - stringWidth(title)), width);
  const stats = padLine(`   ${chalk.gray(`pos ${a.positions ?? '—'} win ${win} pnl `)}${coloredPnl(a.pnl)}`, width);
  if (!isFull) return [head, stats];
  return [head, padLine(`   ${chalk.gray(a.strategy)}`, width), stats, padLine(`   ${winBar(a.winRate)} ${chalk.white(win)}`, width)];
}

function equityRows(p: CockpitProps, width: number): string[] {
  const mode = p.currencyMode ?? 'USD';
  const fx = p.fxRate;
  const since = pnlSinceStart(p);
  const equity = since ? chalk.white.bold(fmtCurrency(p.equity, mode, fx)) : chalk.gray('—');
  const basis = p.mode === 'live' ? 'session' : 'total'; // live has no history, so its baseline is the first balance this process saw
  const change = since ? pnlColor(since.usd)(`${fmtSignedCurrency(since.usd, mode, fx)} (${signedDp(since.pct)}% ${basis})`) : chalk.gray('—');
  const stale = p.venue.state === 'degraded' || p.venue.state === 'down' ? chalk.red(' stale') : ''; // a failing venue means these figures are the last ones it gave
  return [padLine(' ' + chalk.gray('Equity  ') + equity + chalk.gray(` (${p.mode})`) + stale, width), padLine(' ' + change, width)];
}

export function renderCol1Lines(p: CockpitProps, width = 40, rowCount = 29): string[] {
  const mode = p.currencyMode ?? 'USD';
  const fx = p.fxRate;
  const rows: string[] = [
    ...equityRows(p, width),
    padLine(' ' + chalk.gray('uPnL    ') + pnlColor(p.upnl).bold(fmtSignedCurrency(p.upnl, mode, fx)), width),
    padLine(' ' + chalk.gray('Margin  ') + chalk.white(fmtCurrency(p.marginUsed, mode, fx)) + chalk.gray(` (${marginPct(p)}% used)`), width),
    padLine(' ' + chalk.gray('Free    ') + chalk.white(fmtCurrency(freeMargin(p), mode, fx)), width),
    padLine(' ' + chalk.gray(`Lev ${config.risk.minLeverage}-${config.risk.maxLeverage}x │ Margin `) + chalk.yellow('ISOLATED'), width),
  ];
  const fleet = p.agents.slice(0, MAX_FLEET_AGENTS);
  const isFull = rowCount - rows.length >= fleet.length * AGENT_BLOCK_ROWS;
  if (fleet.length === 0) rows.push(padLine(`  ${chalk.gray('no agents reporting')}`, width));
  for (const agent of fleet) rows.push(...agentRows(agent, isFull, width));
  return fillRows(rows, width, rowCount);
}

function positionCard(pos: Position, isSelected: boolean, width: number, pnl: string): string[] {
  const cursor = isSelected ? chalk.yellow.bold('▸') : ' ';
  const sym = isSelected ? chalk.yellow.bold(pos.symbol) : chalk.white.bold(pos.symbol);
  const side = pos.side === 'LONG' ? chalk.green.bold(pos.side) : chalk.red.bold(pos.side);
  const roe = pos.upnlPct * (pos.leverage || 1);
  const pnlPct = pnlColor(pos.upnl)(`(${signedDp(roe)}%)`);
  const headLeft = ` ${cursor} ${sym} ${side} ${chalk.yellow(`${pos.leverage}x`)}`;
  const headRight = `${pnl} ${pnlPct}`;
  const gap = Math.max(1, width - stringWidth(headLeft) - stringWidth(headRight));
  const l1 = headLeft + ' '.repeat(gap) + headRight;

  const ePrice = formatPrice(pos.symbol, pos.entry);
  const mPrice = formatPrice(pos.symbol, pos.mark);
  const qty = formatQty(pos.symbol, pos.qty);
  const l2 = width >= 52
    ? `   ${chalk.gray('Entry ')}${chalk.white(ePrice)}  ${chalk.gray('Mark ')}${chalk.white(mPrice)}  ${chalk.gray('Sz ')}${chalk.white(qty)}`
    : `   ${chalk.gray('e ')}${chalk.white(ePrice)}  ${chalk.gray('m ')}${chalk.white(mPrice)}  ${chalk.gray('sz ')}${chalk.white(qty)}`;
  return [padLine(l1, width), padLine(l2, width), padLine(cardLevelsLine(pos, width), width)];
}

function levelText(pos: Position, level: string): string {
  if (!level || level === '—') return chalk.gray('—');
  const price = Number(level);
  return chalk.white(Number.isFinite(price) ? formatPrice(pos.symbol, price) : level);
}

/** SL, TP and liquidation; an estimated liquidation (the venue reported none) is marked with "~". */
function cardLevelsLine(pos: Position, width: number): string {
  const levels = `   ${chalk.gray('SL ')}${levelText(pos, pos.serverSl)} ${chalk.gray('│ TP ')}${levelText(pos, pos.serverTp)}`;
  const liqVal = pos.liquidationPrice ? `${pos.isLiqEstimated ? '~' : ''}${formatPrice(pos.symbol, pos.liquidationPrice)}` : null;
  if (width < 54) return levels + (liqVal ? ` ${chalk.gray('│ Liq ')}${chalk.yellow(liqVal)}` : '');
  const liqDist = pos.liqDistancePct !== null ? `${dp(pos.liqDistancePct)}%` : null;
  const liqText = liqVal && liqDist ? `${liqVal} (${liqDist})` : liqVal ?? liqDist;
  return `${levels} ${chalk.gray('│ Liq ')}${liqText ? chalk.yellow(liqText) : chalk.gray('—')}`;
}

function positionRow(pos: Position, isSelected: boolean, width: number, pnl: string): string {
  const cursor = isSelected ? chalk.yellow.bold('▸') : ' ';
  const symbol = isSelected ? chalk.white.bold(pos.symbol.padEnd(9)) : chalk.white(pos.symbol.padEnd(9));
  const type = chalk.gray((pos.posType ?? pos.side).padEnd(11));
  const entry = chalk.white(formatPrice(pos.symbol, pos.entry).padEnd(11));
  const wide = ` ${cursor} ${symbol} ${type} ${chalk.gray('e ')}${entry} ${chalk.gray('sz ')}${chalk.white(formatQty(pos.symbol, pos.qty).padEnd(8))} ${pnl}`;
  // Choose by measured width so the uPnL is never the part that gets cut
  return padLine(stringWidth(wide) <= width ? wide : ` ${cursor} ${symbol} ${type} ${pnl}`, width);
}

const OPTION_STATE_LABEL: Record<string, string> = {
  IDLE: 'idle', SIGNAL_DETECTED: 'signal', ENTRY_PENDING: 'entry…', POSITION_OPEN: 'open', EXIT_PENDING: 'exit…', POSITION_CLOSED: 'closed',
};

/** The options book under the futures positions: one header line, then one line per underlying. Empty when the desk is off. */
export function renderOptionsBlock(p: Pick<CockpitProps, 'options'>, width: number): string[] {
  const desk = p.options;
  if (!desk) return [];
  const stateColor = desk.state === 'running' ? chalk.green : desk.state === 'down' ? chalk.red : chalk.yellow;
  const header = ` ${chalk.cyan.bold('OPTIONS')} ${stateColor(desk.venue)}${desk.executing ? '' : chalk.yellow(' monitor')}`;
  // A halt leads its own line so a narrow column can never truncate it away
  const status = `   ${desk.halt ? chalk.red(`HALT ${desk.halt} `) : ''}${chalk.gray(`eq ${desk.equity === null ? '—' : fmtCurrency(desk.equity, 'USD')}`)}`;
  const rows = desk.rows.map((r) => {
    const base = r.underlying.replace(/USDT$/, '').padEnd(4);
    const label = (OPTION_STATE_LABEL[r.state] ?? r.state).padEnd(7);
    if (r.position) {
      const right = r.position.symbol.endsWith('-C') ? chalk.green('CE') : chalk.red('PE');
      const strike = r.position.symbol.split('-')[2];
      return padLine(`   ${chalk.white(base)}${right} ${strike} ${chalk.white(String(r.position.qty))} @${dp(r.position.entry)} ${chalk.gray(`SL ${dp(r.position.stop)} TP ${dp(r.position.target)}`)}`, width);
    }
    return padLine(`   ${chalk.white(base)}${chalk.gray(label)}${chalk.gray(r.note)}`, width);
  });
  return [separator(width), padLine(header, width), padLine(status, width), ...rows];
}

export function renderCol3Lines(p: CockpitProps, width = 34, rowCount = 29): string[] {
  const optionsBlock = renderOptionsBlock(p, width);
  if (optionsBlock.length === 0) return renderFuturesPositions(p, width, rowCount);
  // Futures keep at least half the column; the options block takes what is left and is cut from the bottom if needed.
  const futuresRows = Math.max(Math.ceil(rowCount / 2), rowCount - optionsBlock.length);
  return fillRows([...renderFuturesPositions(p, width, futuresRows), ...optionsBlock], width, rowCount);
}

function renderFuturesPositions(p: CockpitProps, width: number, rowCount: number): string[] {
  const mode = p.currencyMode ?? 'USD';
  const fx = p.fxRate;
  const isFull = p.positions.length <= 6 && width >= 46 && rowCount - 4 >= p.positions.length * 3;
  const rows: string[] = [];
  if (p.positions.length === 0) {
    rows.push(padLine(`   ${chalk.gray('no open positions')}`, width));
  } else {
    p.positions.forEach((pos, i) => {
      const pnl = pnlColor(pos.upnl)(fmtSignedCurrency(pos.upnl, mode, fx));
      const isSel = i === p.selPos;
      rows.push(...(isFull ? positionCard(pos, isSel, width, pnl) : [positionRow(pos, isSel, width, pnl)]));
      if (isFull && i < p.positions.length - 1 && rows.length + 3 < rowCount - 3) {
        rows.push(separator(width));
      }
    });
  }
  if (rows.length < rowCount) {
    const totalUpnl = p.positions.reduce((sum, pos) => sum + pos.upnl, 0);
    rows.push(separator(width));
    rows.push(padLine(`   ${chalk.gray('Total uPnL: ')}${pnlColor(totalUpnl).bold(fmtSignedCurrency(totalUpnl, mode, fx))}`, width));
    rows.push(padLine(`   ${chalk.gray('Positions:  ')}${chalk.white(`${p.positions.length} active`)}`, width));
  }
  return fillRows(rows, width, rowCount);
}

function correlationLabel(corr: number): string {
  const strength = Math.abs(corr) >= HIGH_CORRELATION ? 'high' : Math.abs(corr) >= MEDIUM_CORRELATION ? 'medium' : 'low';
  return `${dp(corr)} ${strength}`;
}

function riskRows(p: CockpitProps, width: number): string[] {
  const label = (text: string) => chalk.gray(text.padEnd(11));
  return [
    padLine(` ${chalk.cyan.bold('RISK-MGR-δ METRICS')}`, width),
    padLine(`   ${label('VaR(95%)')}${chalk.white(orDash(p.var95, signedUsd))}`, width),
    padLine(`   ${label('Exposure')}${chalk.white(`${dp(p.exposurePct)}% / ${config.risk.maxExposurePct}%`)}`, width),
    padLine(`   ${label('MaxDD')}${chalk.white(`${dp(p.maxDd)}% / -${config.risk.maxDrawdownPct}%`)}`, width),
    padLine(`   ${label('Liq dist')}${chalk.white(orDash(p.minLiqDistancePct, (d) => `${dp(d)}%`))}`, width),
    padLine(`   ${label('Corr BTC-E')}${chalk.white(orDash(p.corrBtcEth, correlationLabel))}`, width),
    padLine(`   ${label('Sharpe')}${chalk.white(orDash(p.sharpe, dp))}`, width),
  ];
}

function actionRows(p: CockpitProps, width: number): string[] {
  if (p.positions.length === 0) return [padLine(`   ${chalk.gray('no open positions')}`, width)];
  const start = Math.max(0, Math.min(p.selPos - 1, p.positions.length - MAX_ACTION_ROWS));
  return p.positions.slice(start, start + MAX_ACTION_ROWS).map((pos, i) => {
    const text = `Close ${pos.symbol} ${pos.side}`;
    return padLine(start + i === p.selPos ? `   ${chalk.yellow(`▸${text}`)}` : `    ${chalk.gray(text)}`, width);
  });
}

export function renderCol4Lines(p: CockpitProps, width = 30, rowCount = 29): string[] {
  const mode = p.currencyMode ?? 'USD';
  const fx = p.fxRate;
  const rows: string[] = [
    padLine(` ${chalk.cyan.bold('ACCOUNT & MARGIN')}`, width),
    padLine(`   ${chalk.gray('Unrealized ')}${pnlColor(p.upnl).bold(fmtSignedCurrency(p.upnl, mode, fx))}`, width),
    padLine(`   ${chalk.gray('Margin     ')}${chalk.white(fmtCurrency(p.marginUsed, mode, fx))}${chalk.gray(` (${marginPct(p)}%)`)}`, width),
    padLine(`   ${chalk.gray('Free       ')}${chalk.white(fmtCurrency(freeMargin(p), mode, fx))}`, width),
    separator(width),
    ...riskRows(p, width),
    separator(width),
    padLine(` ${chalk.cyan.bold('POSITION ACTIONS')}`, width),
    ...actionRows(p, width),
  ];
  return fillRows(rows, width, rowCount);
}

export function renderPerfLines(p: CockpitProps, width: number = 128): string[] {
  const innerW = width - 2;
  const sep = chalk.gray(' │ ');
  const scope = p.mode === 'live' ? 'Session' : 'All-time'; // live has no journal, so every figure covers this process only
  const since = pnlSinceStart(p);
  const liq = p.liqEvents === null ? chalk.gray('—') : (p.liqEvents > 0 ? chalk.red.bold : chalk.green.bold)(p.liqEvents);
  const session = [
    chalk.white('Session ') + chalk.cyan.bold(p.sessionDecisions) + chalk.gray(' decisions'),
    chalk.green.bold(p.sessionExecuted) + chalk.gray(' executed'),
    chalk.yellow.bold(p.sessionMonitored) + chalk.gray(' monitored'),
  ].join(sep);
  const results = [
    chalk.white(`${scope} `) + chalk.white.bold(orDash(p.successRate, (rate) => `${dp(rate)}%`)) + chalk.gray(' win'),
    coloredPnl(since?.usd ?? null, p.currencyMode, p.fxRate) + chalk.gray(' PnL'),
    chalk.gray('Sharpe ') + chalk.white.bold(orDash(p.sharpe, dp)),
    chalk.gray('MaxDD ') + chalk.yellow.bold(`${dp(p.maxDd)}%`),
    chalk.gray('liq events ') + liq,
  ].join(sep);
  const text = ' ' + session + chalk.gray(' ║ ') + results;
  return [chalk.yellow('╔' + rule('═', innerW) + '╗'), chalk.yellow('║') + padLine(text, innerW) + chalk.yellow('║'), chalk.yellow('╚' + rule('═', innerW) + '╝')];
}

function venueLabel({ name, state }: CockpitProps['venue']): string {
  return chalk.gray(` │ venue ${name}`) + (state === 'local' ? '' : ' ' + VENUE_COLOR[state](`●${state}`));
}

export function renderFooterLines(p: CockpitProps, width: number = 128): string[] {
  const innerW = width - 2;
  const spinner = p.isSyncing ? chalk.yellow('⠋') : chalk.yellow('⠴');
  const orchestrator = ` │ ${runningCount(p.agents)} agents autonomous │ eval ${LOOP_INTERVAL_MS / 1000}s │ api weight `;
  const l1 = ' ' + spinner + chalk.gray(' orchestrator' + orchestrator) + chalk.white(`${p.apiWeight}/${API_WEIGHT_LIMIT}`) + chalk.gray(' │ ws ') + WS_COLOR[p.wsStatus](`●${p.wsStatus}`)
    + chalk.gray(' │ mode ') + chalk.yellow.bold(config.alertOnly ? `${p.mode.toUpperCase()} (ALERT-ONLY)` : p.mode.toUpperCase()) + venueLabel(p.venue);
  const currTag = p.currencyMode ?? 'USD';
  const commands = [
    chalk.yellow.bold('Tab/m') + ' ' + chalk.gray('mtf-view'),
    chalk.white.bold('↑↓') + ' ' + chalk.gray('nav'),
    chalk.yellow.bold('u') + ' ' + chalk.cyan(currTag),
    chalk.yellow.bold('c') + ' ' + chalk.gray('close-pos'),
    chalk.yellow.bold('x') + ' ' + chalk.gray('cancel'),
    chalk.yellow.bold('k') + ' ' + chalk.gray('kill-switch'),
    chalk.yellow.bold('a') + ' ' + chalk.gray('advisor-audit'),
    chalk.yellow.bold('s') + ' ' + chalk.gray('stop-all'),
    chalk.yellow.bold('?') + ' ' + chalk.gray('help'),
  ];
  const l2 = ' ' + chalk.gray('╰─ ') + commands.join(chalk.gray(' │ '));
  return [chalk.cyan('╭' + rule('─', innerW) + '╮'), chalk.cyan('│') + padLine(l1, innerW) + chalk.cyan('│'), chalk.cyan('│') + padLine(l2, innerW) + chalk.cyan('│'), chalk.cyan('╰' + rule('─', innerW) + '╯')];
}
