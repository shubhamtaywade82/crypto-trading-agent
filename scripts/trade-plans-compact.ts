/**
 * Rewrites the trade-plan ledger with one snapshot per plan. The ledger appends a snapshot per transition, so the file
 * grows over time; the state it holds does not change. Run it only with no other process writing the ledger: the bot,
 * the fleet and the sniper all append to TRADE_PLANS_PATH, and a rewrite that races an append loses that append.
 *
 *   npx tsx scripts/trade-plans-compact.ts           # reports what it would do
 *   npx tsx scripts/trade-plans-compact.ts --yes     # rewrites, if the file is bloated
 *   npx tsx scripts/trade-plans-compact.ts --yes --force
 */
import 'dotenv/config';
import { config } from '../src/config.js';
import { TradePlanLedger } from '../src/ops/tradePlans.js';

const apply = process.argv.includes('--yes');
const force = process.argv.includes('--force');

const ledger = new TradePlanLedger(config.tradePlansPath);
if (ledger.lastError) {
  console.error(`cannot read ${config.tradePlansPath}: ${ledger.lastError}`);
  process.exit(1);
}

const bloated = ledger.needsCompaction();
console.log(`ledger: ${config.tradePlansPath} · plans ${ledger.all().length} · bloated ${bloated ? 'yes' : 'no'}`);

if (!apply) {
  console.log('dry run: pass --yes to rewrite (stop the bot, fleet and sniper first)');
  process.exit(0);
}
if (!bloated && !force) {
  console.log('not bloated; nothing to do (pass --force to rewrite anyway)');
  process.exit(0);
}

const result = ledger.compact();
if (!result) {
  console.error(`compaction failed: ${ledger.lastError ?? 'no file'}`);
  process.exit(1);
}
console.log(`compacted: ${result.before} rows -> ${result.after} rows`);
