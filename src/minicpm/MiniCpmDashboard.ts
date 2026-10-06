import chalk from 'chalk';
import type { WorkerStatus } from './SymbolTraderWorker.js';

export function renderDashboard(startTime: number, workers: WorkerStatus[]): void {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const mins = Math.floor((uptimeSeconds % 3600) / 60);
  const secs = uptimeSeconds % 60;
  const timeStr = `${hours}h ${mins}m ${secs}s`;

  console.clear();
  console.log(chalk.bold.cyan(`═══════════════════════════════════════════════════════════════════════════════════════`));
  console.log(chalk.bold.white(`  ⬡ MINICPM5-2B AUTONOMOUS 24/7 MULTI-SYMBOL TRADER   [Uptime: ${chalk.yellow(timeStr)}]`));
  console.log(chalk.bold.cyan(`═══════════════════════════════════════════════════════════════════════════════════════`));

  for (const w of workers) {
    const acct = w.account;
    const equity = acct ? `$${acct.equity.toFixed(2)}` : 'Loading...';
    const realizedPnl = acct ? (acct.realizedPnl >= 0 ? chalk.green(`+$${acct.realizedPnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(acct.realizedPnl).toFixed(2)}`)) : '$0.00';
    const unrealizedPnl = acct ? (acct.unrealizedPnl >= 0 ? chalk.green(`+$${acct.unrealizedPnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(acct.unrealizedPnl).toFixed(2)}`)) : '$0.00';

    const stateColor = w.state === 'IN_POSITION' ? chalk.bold.green : w.state === 'ANALYZING' ? chalk.bold.yellow : chalk.gray;

    console.log(chalk.bold.magenta(`\n▶ SYMBOL: ${w.symbol}`) + chalk.gray(` (Account: ${w.accountId})`));
    console.log(`  State: ${stateColor(w.state)}  │  Equity: ${chalk.white.bold(equity)}  │  Realized PnL: ${realizedPnl}  │  uPnL: ${unrealizedPnl}`);

    if (w.activePosition) {
      const pos = w.activePosition;
      const side = pos.side.toUpperCase() === 'LONG' ? chalk.green('LONG') : chalk.red('SHORT');
      console.log(`  Position: ${side} ${pos.netQuantity} @ $${pos.averagePrice}  │  Mark: $${pos.currentPrice}  │  uPnL: $${pos.unrealizedPnl.toFixed(2)}`);
    } else {
      console.log(chalk.gray(`  Position: None (Waiting for LLM signal)`));
    }
    console.log(`  Last LLM Decision: ${chalk.cyan(w.lastDecision)}`);
  }

  console.log(chalk.bold.cyan(`\n═══════════════════════════════════════════════════════════════════════════════════════`));
  console.log(chalk.gray(`  Constraints: 10x Isolated Lev · $1,000 Margin · Min 5% Capital Return (0.5% move)`));
}
