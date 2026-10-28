/**
 * Scheduled Market Brief Runner: connects the deterministic market engine,
 * multi-period derivatives, and Telegram notifications into recurring briefs.
 *
 *   npx tsx scripts/run-market-brief.ts [--symbol SOLUSDT] [--once] [--interval 300000]
 */
import 'dotenv/config';
import { MarketBriefService } from '../src/marketBrief/MarketBriefService.js';
import { MarketBriefScheduler } from '../src/marketBrief/MarketBriefScheduler.js';
import type { MarketBrief } from '../src/marketBrief/types.js';

function parseArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const symbol = parseArg('symbol', process.env.MARKET_BRIEF_SYMBOLS ?? 'SOLUSDT').toUpperCase();
  const intervalMs = Number(parseArg('interval', process.env.MARKET_BRIEF_INTERVAL_MS ?? '300000'));
  const isOnce = process.argv.includes('--once');

  console.log(`Starting Market Brief Service for ${symbol} (Cadence: ${intervalMs / 1000}s)`);

  const service = new MarketBriefService();
  const scheduler = new MarketBriefScheduler(service, {
    symbols: [symbol],
    intervalMs,
    alertOnChange: true,
    onBriefEmitted: (brief: MarketBrief, card: string) => {
      console.log(`\n--- [MARKET BRIEF: ${brief.symbol} ${brief.decision.action}] ---`);
      console.log(card);
    },
  });

  if (isOnce) {
    await scheduler.tick();
    console.log('\nOne-shot brief generation complete.');
    process.exit(0);
  }

  scheduler.start();

  const stop = () => {
    console.log('\nStopping Market Brief Service...');
    scheduler.stop();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  process.exit(1);
});
