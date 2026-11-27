/**
 * Read-only summary of setup outcomes (SETUP_OUTCOMES_PATH): how each kind and direction of setup played out, with
 * hit rate and net R. Setups are hypothetical (no position is opened), so they are reported here and not written into
 * the trade-plan ledger. The file is only read: opening SetupOutcomeLedger would rewrite its open rows.
 *
 *   npx tsx scripts/setup-outcomes-report.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import 'dotenv/config';
import { config } from '../src/config.js';
import { summarizeSetupOutcomes, type SetupOutcomeRecord } from '../src/learning/SetupOutcomeLedger.js';

const path = config.setupOutcomesPath;
if (!existsSync(path)) {
  console.log(`no setup outcomes yet: ${path}`);
  process.exit(0);
}

// The file holds one row per change; the last row per setupId is its state
const latest = new Map<string, SetupOutcomeRecord>();
for (const line of readFileSync(path, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const record = JSON.parse(line) as SetupOutcomeRecord;
    if (typeof record.setupId === 'string') latest.set(record.setupId, record);
  } catch {
    // a torn line from a crash: skipped
  }
}

const pct = (value: number | null): string => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null): string => (value === null ? '—' : value.toFixed(3));

const groups = summarizeSetupOutcomes([...latest.values()], (record) => `${record.kind} ${record.direction}`);
console.log(`setups: ${latest.size} · groups: ${groups.length} · ${path}`);
console.table(groups.map((g) => ({
  group: g.key,
  created: g.created,
  filled: g.filled,
  resolved: g.resolved,
  tp1Rate: pct(g.tp1Rate),
  meanNetR: num(g.meanNetR),
  lcbNetR90: num(g.lcbNetR),
})));
