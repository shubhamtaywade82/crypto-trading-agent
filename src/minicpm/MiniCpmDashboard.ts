import chalk from 'chalk';
import type { WorkerStatus } from './SymbolTraderWorker.js';

export interface DashboardContext {
  startTime: number;
  btcPrice: number;
  btcTrend1h: string;
  btcTrend15m: string;
  btcChange24h: number;
  workers: WorkerStatus[];
}

// Strip ANSI control codes for exact visual character length calculation
const stripAnsi = (str: string): string => str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

function padCell(content: string, visibleWidth: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const len = stripAnsi(content).length;
  const diff = visibleWidth - len;
  if (diff <= 0) return content;
  if (align === 'right') return ' '.repeat(diff) + content;
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return ' '.repeat(left) + content + ' '.repeat(right);
  }
  return content + ' '.repeat(diff);
}

function fmtPrice(val: number): string {
  if (val >= 1000) return val.toFixed(2);
  if (val >= 10) return val.toFixed(2);
  return val.toFixed(4);
}

function trajectoryMeter(current: number, entry: number, sl: number, tp: number, isLong: boolean): string {
  const span = Math.abs(tp - sl);
  if (span <= 0) return chalk.gray('───────────────');

  const ratio = isLong ? (current - sl) / span : (sl - current) / span;
  const clamped = Math.max(0, Math.min(1, ratio));
  const len = 14;
  const pin = Math.round(clamped * (len - 1));

  let out = '';
  for (let i = 0; i < len; i++) {
    if (i === pin) out += chalk.bold.yellow('◆');
    else if (i < pin) out += chalk.green('─');
    else out += chalk.gray('─');
  }
  return out;
}

export function renderDashboard(ctx: DashboardContext): void {
  const { startTime, btcPrice, btcTrend1h, btcTrend15m, btcChange24h, workers } = ctx;
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const mins = Math.floor((uptimeSeconds % 3600) / 60);
  const secs = uptimeSeconds % 60;
  const timeStr = `${hours}h ${mins}m ${secs}s`;

  let totalEquity = 0;
  let totalUpnl = 0;
  let totalRealized = 0;
  let activeCount = 0;

  for (const w of workers) {
    if (w.account) {
      totalEquity += w.account.equity;
      totalRealized += w.account.realizedPnl;
    }
    if (w.activePosition) {
      totalUpnl += w.activePosition.unrealizedPnl;
      activeCount++;
    }
  }

  const btcChangeStr = btcChange24h >= 0 ? chalk.green(`+${btcChange24h.toFixed(2)}%`) : chalk.red(`${btcChange24h.toFixed(2)}%`);
  const btcTrendStr = btcTrend1h === 'BULLISH' ? chalk.bold.green('▲ BULL') : btcTrend1h === 'BEARISH' ? chalk.bold.red('▼ BEAR') : chalk.gray('■ FLAT');
  const upnlColor = totalUpnl >= 0 ? chalk.bold.green(`+$${totalUpnl.toFixed(2)}`) : chalk.bold.red(`-$${Math.abs(totalUpnl).toFixed(2)}`);
  const realizedColor = totalRealized >= 0 ? chalk.green(`+$${totalRealized.toFixed(2)}`) : chalk.red(`-$${Math.abs(totalRealized).toFixed(2)}`);

  console.clear();
  const BOX_WIDTH = 106;

  // Header Box
  console.log(chalk.bold.cyan('╔' + '═'.repeat(BOX_WIDTH) + '╗'));

  const row1Content =
    chalk.bold.white(' ⬡ MINICPM-2B COCKPIT v2.0 ') +
    chalk.gray('│ Uptime: ') + chalk.yellow(timeStr) +
    chalk.gray(' │ Active: ') + chalk.bold.white(`${activeCount}/3 Symbols`) +
    chalk.gray(' │ BTC Anchor: ') + chalk.bold.white(`$${btcPrice > 0 ? btcPrice.toLocaleString() : '—'}`) + ' ' + btcTrendStr + ` (${btcChangeStr})`;
  console.log(chalk.bold.cyan('║') + padCell(row1Content, BOX_WIDTH, 'left') + chalk.bold.cyan('║'));

  const row2Content =
    chalk.gray(' PORTFOLIO: Total Equity: ') + chalk.bold.white(`$${totalEquity.toFixed(2)}`) +
    chalk.gray(' │ Open uPnL: ') + upnlColor +
    chalk.gray(' │ Realized: ') + realizedColor +
    chalk.gray(' │ Venue: ') + chalk.green('● paper_exchange');
  console.log(chalk.bold.cyan('║') + padCell(row2Content, BOX_WIDTH, 'left') + chalk.bold.cyan('║'));

  console.log(chalk.bold.cyan('╠' + '═'.repeat(BOX_WIDTH) + '╣'));

  // Column definitions (Exact total matching BOX_WIDTH: 8 + 1 + 11 + 1 + 22 + 1 + 19 + 1 + 42 = 106)
  const W_ASSET = 8;
  const W_SIDE = 11;
  const W_PRICE = 22;
  const W_PNL = 19;
  const W_TRAJ = 42;

  const headerRow =
    padCell(chalk.bold.cyan(' ASSET'), W_ASSET, 'left') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' POSITION'), W_SIDE, 'left') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' ENTRY ➔ MARK'), W_PRICE, 'center') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' uPnL (RET%)'), W_PNL, 'center') + chalk.gray('│') +
    padCell(chalk.bold.cyan(' TARGET TRAJECTORY (SL ➔ TP)'), W_TRAJ, 'center');
  console.log(chalk.bold.cyan('║') + headerRow + chalk.bold.cyan('║'));

  const divRow =
    '─'.repeat(W_ASSET) + chalk.gray('┼') +
    '─'.repeat(W_SIDE) + chalk.gray('┼') +
    '─'.repeat(W_PRICE) + chalk.gray('┼') +
    '─'.repeat(W_PNL) + chalk.gray('┼') +
    '─'.repeat(W_TRAJ);
  console.log(chalk.bold.cyan('╟') + chalk.gray(divRow) + chalk.bold.cyan('╢'));

  // Table Body Rows
  for (const w of workers) {
    const sym = ' ' + w.symbol.replace('USDT', '');
    const cellAsset = padCell(chalk.bold.white(sym), W_ASSET, 'left');

    if (w.activePosition) {
      const pos = w.activePosition;
      const isLong = pos.side.toUpperCase() === 'LONG';
      const sideText = isLong ? chalk.bold.green(' LONG 10x') : chalk.bold.red(' SHORT 10x');
      const cellSide = padCell(sideText, W_SIDE, 'left');

      const entryStr = `$${fmtPrice(pos.averagePrice)}`;
      const markStr = `$${fmtPrice(pos.currentPrice)}`;
      const cellPrice = padCell(`${entryStr} ➔ ${markStr}`, W_PRICE, 'center');

      const retPctNum = (pos.unrealizedPnl / 980) * 100;
      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '-';
      const pnlText = `${pnlSign}$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;
      const retText = `(${retPctNum >= 0 ? '+' : ''}${retPctNum.toFixed(1)}%)`;
      const pnlStyled = pos.unrealizedPnl >= 0 ? chalk.green(`${pnlText} ${retText}`) : chalk.red(`${pnlText} ${retText}`);
      const cellPnl = padCell(pnlStyled, W_PNL, 'center');

      let trajContent = chalk.gray('— no levels —');
      if (w.stopLoss && w.takeProfit) {
        const slFmt = fmtPrice(w.stopLoss);
        const tpFmt = fmtPrice(w.takeProfit);
        const bar = trajectoryMeter(pos.currentPrice, pos.averagePrice, w.stopLoss, w.takeProfit, isLong);
        trajContent = `${chalk.red(slFmt)} ${bar} ${chalk.green(tpFmt)}`;
      }
      const cellTraj = padCell(trajContent, W_TRAJ, 'center');

      console.log(chalk.bold.cyan('║') + cellAsset + chalk.gray('│') + cellSide + chalk.gray('│') + cellPrice + chalk.gray('│') + cellPnl + chalk.gray('│') + cellTraj + chalk.bold.cyan('║'));
    } else {
      const cellSide = padCell(chalk.gray(' IDLE'), W_SIDE, 'left');
      const cellPrice = padCell(chalk.gray('—'), W_PRICE, 'center');
      const cellPnl = padCell(chalk.gray('$0.00 (0.0%)'), W_PNL, 'center');
      const cellTraj = padCell(chalk.italic.gray('Scanning market with MiniCPM...'), W_TRAJ, 'center');
      console.log(chalk.bold.cyan('║') + cellAsset + chalk.gray('│') + cellSide + chalk.gray('│') + cellPrice + chalk.gray('│') + cellPnl + chalk.gray('│') + cellTraj + chalk.bold.cyan('║'));
    }
  }

  console.log(chalk.bold.cyan('╠' + '═'.repeat(BOX_WIDTH) + '╣'));

  // Bottom Intelligence Panel
  const intelHeader = chalk.bold.white(' LATEST LLM INTELLIGENCE & REASONING:');
  console.log(chalk.bold.cyan('║') + padCell(intelHeader, BOX_WIDTH, 'left') + chalk.bold.cyan('║'));

  for (const w of workers) {
    const sym = w.symbol.replace('USDT', '');
    const beNotice = w.breakEvenMoved ? chalk.bold.cyan(' [PROTECTED BREAK-EVEN]') : '';
    let decision = w.lastDecision.replace(/^Recovered:\s*/, '');
    const line = `  ${chalk.bold.magenta(sym)}: ${chalk.white(decision)}${beNotice}`;
    console.log(chalk.bold.cyan('║') + padCell(line, BOX_WIDTH, 'left') + chalk.bold.cyan('║'));
  }

  console.log(chalk.bold.cyan('╚' + '═'.repeat(BOX_WIDTH) + '╝'));
  console.log(chalk.gray('  Rule: $980 Margin · 10x Isolated · Min +5% TP · Auto Break-Even Trailing · 24/7 Realtime'));
}
