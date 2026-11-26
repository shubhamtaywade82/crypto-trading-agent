/**
 * Prints what became of every recorded trade plan: the announced card, whether it was delivered, and the resolved
 * outcome (TP / SL / close, PnL, R). Reads TRADE_PLANS_PATH; nothing is written.
 *
 *   npx tsx scripts/trade-plans-report.ts [--source SIGNAL|FLEET|SNIPER] [--symbol BTCUSDT] [--open]
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { summarizeTradePlans, TradePlanLedger, type TradePlan } from '../src/ops/tradePlans.js';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const source = arg('source');
const symbol = arg('symbol')?.toUpperCase();
const openOnly = process.argv.includes('--open');

const ledger = new TradePlanLedger(config.tradePlansPath);
if (ledger.lastError) console.warn(`[plans] ${ledger.lastError}`);

const plans = ledger.all()
  .filter((p) => (source === undefined || p.source === source) && (symbol === undefined || p.symbol === symbol))
  .filter((p) => !openOnly || p.status === 'ANNOUNCED' || p.status === 'FILLED')
  .sort((a, b) => a.announcedAt - b.announcedAt);

const pct = (value: number | null): string => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null, digits = 2): string => (value === null ? '—' : value.toFixed(digits));

const summary = summarizeTradePlans(plans);
console.log(`plans: ${summary.total} · open ${summary.open} · closed ${summary.closed} · unobserved ${summary.unobserved} · not filled ${summary.notFilled}`);
console.log(`outcome: win rate ${pct(summary.winRate)} (${summary.wins}W/${summary.losses}L) · mean R ${num(summary.meanR)} · PnL ${num(summary.totalPnl)} USD`);
console.log(`cards that failed to reach the chat: ${summary.cardsFailed}`);

const rows = plans.map((p: TradePlan) => ({
  announced: new Date(p.announcedAt).toISOString().slice(0, 16),
  source: p.source,
  symbol: p.symbol,
  side: p.side,
  status: p.status,
  result: p.result ?? '',
  entry: p.planned.entry,
  stop: p.planned.stopLoss,
  target: p.planned.takeProfit,
  exit: p.exitPrice ?? '',
  pnl: p.pnl ?? '',
  R: num(p.rMultiple),
  card: p.announceNotify,
  closeCard: p.closeNotify,
  planId: p.planId,
}));
console.table(rows);
