/**
 * Prints the hypothetical brief calls (BUY_LONG / SELL_SHORT): how many filled, how each resolved (TP / SL / EXPIRED /
 * NOT_FILLED) and the mean R over filled calls that resolved. Reads BRIEF_CALLS_PATH; nothing is written.
 *
 *   npx tsx scripts/brief-calls-report.ts [--symbol SOLUSDT] [--open]
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { BriefCallLedger, summarizeCalls } from '../src/marketBrief/BriefCalls.js';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const symbol = arg('symbol')?.toUpperCase();
const openOnly = process.argv.includes('--open');

const ledger = new BriefCallLedger(config.briefCallsPath);
if (ledger.lastError) console.warn(`[calls] ${ledger.lastError}`);

const calls = ledger
  .all()
  .filter((c) => symbol === undefined || c.symbol === symbol)
  .filter((c) => !openOnly || c.status === 'OPEN')
  .sort((a, b) => a.openedAt - b.openedAt);

const s = summarizeCalls(calls);
const stamp = (ms: number | null): string => (ms === null ? '' : new Date(ms).toISOString().slice(0, 16));

console.log(`calls: ${s.total} · open ${s.open} · filled ${s.filled} · TP ${s.tp} · SL ${s.sl} · expired ${s.expired} · not filled ${s.notFilled}`);
console.log(`mean R (filled, resolved): ${s.meanR === null ? '—' : s.meanR.toFixed(2)}`);

console.table(
  calls.map((c) => ({
    opened: stamp(c.openedAt),
    symbol: c.symbol,
    direction: c.direction,
    status: c.status,
    entry: c.entry,
    stop: c.stop,
    target: c.target,
    filled: stamp(c.filledAt),
    resolved: stamp(c.resolvedAt),
    exit: c.exitPrice ?? '',
    R: c.rMultiple === null ? '—' : c.rMultiple.toFixed(2),
    callId: c.callId,
  })),
);
