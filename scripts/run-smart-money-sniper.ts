/**
 * Smart Money Sniper Bot: monitors Binance Web3 on-chain signals, filters
 * for high-conviction Pumpfun & DEX Paid entries, alerts to Telegram, and
 * tracks automated +20% TP / -10% SL sniper executions.
 *
 * Every position is recorded in the trade-plan ledger (TRADE_PLANS_PATH): the alert, whether it was delivered, and
 * the resolved TP / SL / time-stop with its PnL. On restart the open positions and the processed signals are
 * rebuilt from that ledger.
 *
 *   npx tsx scripts/run-smart-money-sniper.ts [--once] [--chain CT_501] [--interval 15000]
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import {
  fetchSmartMoneySignals,
  isSniperEligible,
  createSniperPosition,
  evaluatePositionTick,
  formatSniperCard,
  type SmartMoneySignal,
  type SniperPosition,
} from '../src/execution/SmartMoneySniper.js';
import { announceSniperPlan, recordSniperExit, restoreSniperState, settleSniperPosition, sniperPlanId } from '../src/execution/sniperPlans.js';
import { sendTelegram } from '../src/ops/telegram.js';
import { TradePlanLedger, type NotifyStatus } from '../src/ops/tradePlans.js';

interface RuntimeState {
  readonly processedSignalIds: Set<number>;
  readonly openPositions: Map<number, SniperPosition>;
  /** The last price the feed showed per signal. Used only for a time stop after the signal left the feed. */
  readonly lastPrice: Map<number, number>;
  readonly plans: TradePlanLedger;
}

function parseCliArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const deliveryOf = (ok: boolean): NotifyStatus => (ok ? 'SENT' : 'FAILED');

// Dispatches formatted alert card to Telegram trading channel
async function broadcastSniperAlert(signal: SmartMoneySignal, pos: SniperPosition, plans: TradePlanLedger): Promise<void> {
  const card = formatSniperCard(signal, pos);
  console.log(`\n[SNIPER ALERT] ${signal.ticker} on ${signal.chainId} | Entry: $${pos.entryPrice}`);
  console.log(`Target (+20%): $${pos.targetPrice} | Stop (-10%): $${pos.stopPrice}`);

  const ok = await sendTelegram(card, { channel: 'trading' });
  plans.notify(sniperPlanId(pos.signalId), 'announce', deliveryOf(ok), Date.now());
}

// Broadcasts trade resolution card to Telegram trading channel
async function broadcastExitAlert(pos: SniperPosition, plans: TradePlanLedger): Promise<void> {
  const emoji = pos.status === 'TP_HIT' ? '🎉' : pos.status === 'SL_HIT' ? '🛑' : '⏱️';
  const pnlText = pos.realizedPnlUsd === undefined
    ? 'unknown (no price observed)'
    : `${pos.realizedPnlUsd >= 0 ? '+' : ''}$${pos.realizedPnlUsd.toFixed(2)} USD`;

  const lines = [
    `${emoji} <b>SNIPER POSITION CLOSED: ${pos.ticker}</b>`,
    ``,
    `📌 <b>Status:</b> ${pos.status}`,
    `📥 <b>Entry:</b> $${pos.entryPrice.toFixed(8)}`,
    `📤 <b>Exit:</b> $${pos.exitPrice?.toFixed(8) ?? '-'}`,
    `💰 <b>Realized PnL:</b> ${pnlText}`,
  ];

  console.log(`[SNIPER EXIT] ${pos.ticker} resolved ${pos.status} (${pnlText})`);
  const ok = await sendTelegram(lines.join('\n'), { channel: 'trading' });
  plans.notify(sniperPlanId(pos.signalId), 'close', deliveryOf(ok), Date.now());
}

// Updates open positions against current price ticks
// Settles every open position: a feed price decides as before, and a position whose signal left the feed can still time out
async function reconcilePositions(state: RuntimeState, signals: readonly SmartMoneySignal[]): Promise<void> {
  const now = Date.now();
  const feed = new Map(signals.map((signal) => [signal.signalId, parseFloat(signal.currentPrice)] as const));
  for (const [signalId, price] of feed) {
    if (Number.isFinite(price)) state.lastPrice.set(signalId, price);
  }
  for (const [signalId, pos] of [...state.openPositions]) {
    const updated = settleSniperPosition(pos, feed.get(signalId), state.lastPrice.get(signalId), now);
    if (updated.status === 'OPEN') continue;
    state.openPositions.delete(signalId);
    recordSniperExit(state.plans, updated, now);
    await broadcastExitAlert(updated, state.plans);
  }
}

// Scans latest signals, enters eligible positions, and checks open orders
async function pollCycle(state: RuntimeState, chainId: string): Promise<void> {
  try {
    const signals = await fetchSmartMoneySignals(chainId, 50);

    for (const signal of signals) {
      if (state.processedSignalIds.has(signal.signalId)) continue;
      state.processedSignalIds.add(signal.signalId);

      if (!isSniperEligible(signal)) continue;

      const position = createSniperPosition(signal);
      state.openPositions.set(signal.signalId, position);
      // Recorded before the card goes out, so a crash between the two still leaves the position on the books
      announceSniperPlan(state.plans, position);
      await broadcastSniperAlert(signal, position, state.plans);
    }

    await reconcilePositions(state, signals);
  } catch (err) {
    console.error(`[SNIPER ERROR] ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const chainId = parseCliArg('chain', 'CT_501');
  const intervalMs = Number(parseCliArg('interval', '15000'));
  const isOnce = process.argv.includes('--once');

  const plans = new TradePlanLedger(config.tradePlansPath);
  const restored = restoreSniperState(plans);
  if (restored.unrecoverable > 0) {
    console.warn(`[SNIPER] ${restored.unrecoverable} recorded position(s) could not be rebuilt and will not be watched`);
  }
  console.log(`Starting Smart Money Sniper on Chain: ${chainId} (Poll interval: ${intervalMs}ms)`);
  console.log(`Restored ${restored.openPositions.size} open position(s); ${restored.processedSignalIds.size} signal(s) already processed`);

  const state: RuntimeState = {
    processedSignalIds: restored.processedSignalIds,
    openPositions: restored.openPositions,
    lastPrice: new Map(),
    plans,
  };

  let isRunning = true;
  const stop = () => { isRunning = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (isRunning) {
    const start = Date.now();
    await pollCycle(state, chainId);

    if (isOnce) break;
    const elapsed = Date.now() - start;
    await new Promise((res) => setTimeout(res, Math.max(1000, intervalMs - elapsed)));
  }

  console.log('Smart Money Sniper shutdown complete.');
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  process.exit(1);
});
