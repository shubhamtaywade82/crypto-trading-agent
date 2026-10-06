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

function progressBar(current: number, entry: number, sl: number, tp: number, isLong: boolean): string {
  const totalSpan = Math.abs(tp - sl);
  if (totalSpan <= 0) return chalk.gray('────────────────────');

  // Normalized position [0, 1] from SL to TP
  const ratio = isLong ? (current - sl) / totalSpan : (sl - current) / totalSpan;
  const clamped = Math.max(0, Math.min(1, ratio));
  const barLen = 22;
  const dotPos = Math.round(clamped * (barLen - 1));

  let out = '';
  for (let i = 0; i < barLen; i++) {
    if (i === dotPos) {
      out += chalk.bold.yellow('■');
    } else if (i < dotPos) {
      out += chalk.green('─');
    } else {
      out += chalk.gray('─');
    }
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

  // Aggregate metrics
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

  const btcChangeColor = btcChange24h >= 0 ? chalk.green(`+${btcChange24h.toFixed(2)}%`) : chalk.red(`${btcChange24h.toFixed(2)}%`);
  const btcTrendColor = btcTrend1h === 'BULLISH' ? chalk.bold.green('▲ BULLISH') : btcTrend1h === 'BEARISH' ? chalk.bold.red('▼ BEARISH') : chalk.gray('■ SIDEWAYS');

  const totalUpnlColor = totalUpnl >= 0 ? chalk.bold.green(`+$${totalUpnl.toFixed(2)}`) : chalk.bold.red(`-$${Math.abs(totalUpnl).toFixed(2)}`);
  const totalRealizedColor = totalRealized >= 0 ? chalk.bold.green(`+$${totalRealized.toFixed(2)}`) : chalk.bold.red(`-$${Math.abs(totalRealized).toFixed(2)}`);

  console.clear();
  console.log(chalk.cyan('┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐'));
  console.log(
    chalk.cyan('│') +
    chalk.bold.white(` ⬡ MINICPM-2B AUTONOMOUS TRADING COCKPIT `) +
    chalk.gray(`v2.0 │ Uptime: `) + chalk.yellow(timeStr) +
    chalk.gray(` │ Active: `) + chalk.bold.white(`${activeCount}/3`) +
    ' '.repeat(26) +
    chalk.cyan('│')
  );
  console.log(
    chalk.cyan('│') +
    chalk.gray(` BTC Anchor: `) + chalk.bold.white(`$${btcPrice.toLocaleString()}`) + ` ${btcTrendColor} ` +
    chalk.gray(`(24h: ${btcChangeColor}) │ 15m: ${btcTrend15m}`) +
    ' '.repeat(24) +
    chalk.cyan('│')
  );
  console.log(chalk.cyan('├────────────────────────────────────────────────────────────────────────────────────────────────────────┤'));
  console.log(
    chalk.cyan('│') +
    chalk.gray(` PORTFOLIO: Total Equity: `) + chalk.bold.white(`$${totalEquity.toFixed(2)}`) +
    chalk.gray(` │ Realized: `) + totalRealizedColor +
    chalk.gray(` │ Open uPnL: `) + totalUpnlColor +
    ' '.repeat(20) +
    chalk.cyan('│')
  );
  console.log(chalk.cyan('└────────────────────────────────────────────────────────────────────────────────────────────────────────┘'));

  for (const w of workers) {
    const acct = w.account;
    const equity = acct ? `$${acct.equity.toFixed(2)}` : 'Loading...';
    const realizedPnl = acct ? (acct.realizedPnl >= 0 ? chalk.green(`+$${acct.realizedPnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(acct.realizedPnl).toFixed(2)}`)) : '$0.00';

    const stateColor = w.state === 'IN_POSITION' ? chalk.bold.green('● ACTIVE') : w.state === 'ANALYZING' ? chalk.bold.yellow('◐ ANALYZING') : chalk.gray('○ IDLE');

    console.log(chalk.bold.magenta(`\n▶ ${w.symbol}`) + chalk.gray(` [${w.accountId}] `) + stateColor + chalk.gray(` │ Equity: `) + chalk.bold.white(equity) + chalk.gray(` │ Realized: `) + realizedPnl);

    if (w.activePosition) {
      const pos = w.activePosition;
      const isLong = pos.side.toUpperCase() === 'LONG';
      const sideTag = isLong ? chalk.bold.black.bgGreen(' LONG ') : chalk.bold.black.bgRed(' SHORT ');
      const upnlColor = pos.unrealizedPnl >= 0 ? chalk.bold.green(`+$${pos.unrealizedPnl.toFixed(2)}`) : chalk.bold.red(`-$${Math.abs(pos.unrealizedPnl).toFixed(2)}`);
      const returnPct = ((pos.unrealizedPnl / 980) * 100).toFixed(2);
      const returnStr = Number(returnPct) >= 0 ? chalk.green(`(+${returnPct}%)`) : chalk.red(`(${returnPct}%)`);

      const slStr = w.stopLoss ? `$${w.stopLoss} (${w.slDistancePct !== null && w.slDistancePct >= 0 ? '+' : ''}${w.slDistancePct}%)` : '—';
      const tpStr = w.takeProfit ? `$${w.takeProfit} (${w.tpDistancePct !== null && w.tpDistancePct >= 0 ? '+' : ''}${w.tpDistancePct}%)` : '—';
      const beTag = w.breakEvenMoved ? chalk.bold.cyan(' [PROTECTED / BREAK-EVEN]') : '';

      console.log(`  ${sideTag} ${chalk.white.bold(pos.netQuantity)} @ $${pos.averagePrice} ➔ Mark: ${chalk.bold.yellow(`$${pos.currentPrice}`)} │ uPnL: ${upnlColor} ${returnStr}`);
      console.log(`  Targets: ${chalk.red('SL')} ${slStr} │ ${chalk.green('TP')} ${tpStr}${beTag}`);

      if (w.stopLoss && w.takeProfit) {
        const bar = progressBar(pos.currentPrice, pos.averagePrice, w.stopLoss, w.takeProfit, isLong);
        console.log(`  Trajectory: [SL $${w.stopLoss}] ${bar} [TP $${w.takeProfit}]`);
      }
    } else {
      console.log(chalk.gray(`  Position: None │ Waiting for LLM structure trigger`));
    }

    console.log(chalk.gray(`  Reasoning: `) + chalk.italic(w.lastDecision.length > 105 ? w.lastDecision.slice(0, 102) + '...' : w.lastDecision));
  }

  console.log(chalk.cyan(`\n──────────────────────────────────────────────────────────────────────────────────────────────────────────`));
  console.log(chalk.gray(`  Engine: openbmb/minicpm5-2b │ Venue: paper_exchange │ 10x Isolated Lev · $980 Margin · Trailing Break-Even`));
}
