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
  const len = 16;
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
  // TOP COMPACT TELEMETRY BAR
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════════════════════════════════════════════════════════════╗'));
  console.log(
    chalk.bold.cyan('║') +
    chalk.bold.white(' ⬡ MINICPM-2B COCKPIT v2.0 ') +
    chalk.gray('│ Up: ') + chalk.yellow(timeStr) +
    chalk.gray(' │ Fleet: ') + chalk.bold.white(`${activeCount}/3 Active`) +
    chalk.gray(' │ BTC: ') + chalk.bold.white(`$${btcPrice > 0 ? btcPrice.toLocaleString() : '—'}`) + ' ' + btcTrendStr + ` (${btcChangeStr})` +
    chalk.cyan(' ║')
  );
  console.log(
    chalk.bold.cyan('║') +
    chalk.gray(' PORTFOLIO: Equity: ') + chalk.bold.white(`$${totalEquity.toFixed(2)}`) +
    chalk.gray(' │ Open uPnL: ') + upnlColor +
    chalk.gray(' │ Realized: ') + realizedColor +
    chalk.gray(' │ Venue: ') + chalk.green('● paper_exchange') +
    chalk.cyan('                       ║')
  );
  console.log(chalk.bold.cyan('╠══════════════════════════════════════════════════════════════════════════════════════════════════════════════╣'));

  // CLEAN STRUCTURED TABLE HEADERS
  console.log(
    chalk.gray('║') +
    chalk.bold.cyan(' ASSET ') +
    chalk.gray('│') +
    chalk.bold.cyan(' POSITION ') +
    chalk.gray('│') +
    chalk.bold.cyan(' ENTRY ➔ MARK      ') +
    chalk.gray('│') +
    chalk.bold.cyan(' uPnL (RET%)     ') +
    chalk.gray('│') +
    chalk.bold.cyan(' TARGET TRAJECTORY (SL ➔ TP)      ') +
    chalk.gray('║')
  );
  console.log(chalk.gray('╟───────┼──────────┼──────────────────┼─────────────────┼──────────────────────────────────╢'));

  for (const w of workers) {
    const symShort = w.symbol.replace('USDT', '').padEnd(5);
    if (w.activePosition) {
      const pos = w.activePosition;
      const isLong = pos.side.toUpperCase() === 'LONG';
      const sideTag = isLong ? chalk.bold.green('LONG 10x ') : chalk.bold.red('SHORT 10x');
      const entryStr = `$${fmtPrice(pos.averagePrice)}`;
      const markStr = `$${fmtPrice(pos.currentPrice)}`;
      const priceFlow = `${entryStr.padStart(7)} ➔ ${markStr.padEnd(7)}`;

      const retPctNum = (pos.unrealizedPnl / 980) * 100;
      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '-';
      const pnlText = `${pnlSign}$${Math.abs(pos.unrealizedPnl).toFixed(2)}`;
      const retText = `(${retPctNum >= 0 ? '+' : ''}${retPctNum.toFixed(1)}%)`;
      const pnlCombined = pos.unrealizedPnl >= 0 ? chalk.green(`${pnlText.padStart(7)} ${retText.padEnd(7)}`) : chalk.red(`${pnlText.padStart(7)} ${retText.padEnd(7)}`);

      let traj = chalk.gray('— no levels —');
      if (w.stopLoss && w.takeProfit) {
        const slFmt = fmtPrice(w.stopLoss);
        const tpFmt = fmtPrice(w.takeProfit);
        const bar = trajectoryMeter(pos.currentPrice, pos.averagePrice, w.stopLoss, w.takeProfit, isLong);
        const slTag = chalk.red(slFmt);
        const tpTag = chalk.green(tpFmt);
        traj = `${slTag} ${bar} ${tpTag}`;
      }

      console.log(
        chalk.gray('║') + ` ${chalk.bold.white(symShort)} ` +
        chalk.gray('│') + ` ${sideTag} ` +
        chalk.gray('│') + ` ${priceFlow} ` +
        chalk.gray('│') + ` ${pnlCombined} ` +
        chalk.gray('│') + ` ${traj} ` +
        chalk.gray('║')
      );
    } else {
      console.log(
        chalk.gray('║') + ` ${chalk.bold.white(symShort)} ` +
        chalk.gray('│') + chalk.gray(' IDLE     ') +
        chalk.gray('│') + chalk.gray(' —                ') +
        chalk.gray('│') + chalk.gray(' $0.00 (0.0%)    ') +
        chalk.gray('│') + chalk.italic.gray(' Scanning market with MiniCPM...   ') +
        chalk.gray('║')
      );
    }
  }

  console.log(chalk.bold.cyan('╠══════════════════════════════════════════════════════════════════════════════════════════════════════════════╣'));

  // LLM INSIGHTS / REASONING PANEL
  console.log(chalk.bold.cyan('║') + chalk.bold.white(' LATEST LLM INTELLIGENCE & REASONING:') + ' '.repeat(67) + chalk.bold.cyan('║'));
  for (const w of workers) {
    const sym = w.symbol.replace('USDT', '');
    const beNotice = w.breakEvenMoved ? chalk.bold.cyan(' [PROTECTED BREAK-EVEN]') : '';
    let decision = w.lastDecision.replace(/^Recovered:\s*/, '');
    if (decision.length > 88) decision = decision.slice(0, 85) + '...';
    console.log(
      chalk.bold.cyan('║') +
      `  ${chalk.bold.magenta(sym.padEnd(4))}: ${chalk.white(decision)}${beNotice}`.padEnd(108) +
      chalk.bold.cyan('║')
    );
  }

  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════════════════════════════════════════════════════════╝'));
  console.log(chalk.gray('  Rule: $980 Margin · 10x Isolated · Min +5% TP · Auto Break-Even Trailing · 24/7 Realtime'));
}
