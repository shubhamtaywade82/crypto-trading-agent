/**
 * Replays raw tick logs and verifies parity against live-sampled health hashes.
 *
 *   npx tsx scripts/replay-ticks.ts [--dir data/ticks] [--symbol BTCUSDT] [--day YYYY-MM-DD] [--assert-hash]
 */
import path from 'node:path';
import { TickLogReader } from '../src/marketdata/ticks/TickLogReader.js';
import { TickReplay } from '../src/marketdata/ticks/TickReplay.js';

interface CliArgs {
  dir: string;
  symbol: string;
  day?: string;
  hour?: string;
  assertHash: boolean;
}

function parseCli(): CliArgs {
  const get = (k: string, fb: string) => {
    const idx = process.argv.indexOf(`--${k}`);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fb;
  };
  return {
    dir: path.resolve(get('dir', 'data/ticks')),
    symbol: get('symbol', 'BTCUSDT').toUpperCase(),
    day: get('day', '') || undefined,
    hour: get('hour', '') || undefined,
    assertHash: process.argv.includes('--assert-hash'),
  };
}

async function main(): Promise<void> {
  const args = parseCli();
  const reader = new TickLogReader({ dir: args.dir, symbol: args.symbol, day: args.day, hour: args.hour });
  const files = await reader.files();
  if (files.length === 0) {
    console.error(`no tick files found for ${args.symbol} in ${args.dir}`);
    process.exit(1);
  }

  console.log(`replaying ${files.length} file(s) for ${args.symbol}...`);
  const replay = new TickReplay(args.symbol);
  const report = await replay.run(reader, { assertParity: args.assertHash });

  console.log(`replay complete: ${report.events} events, ${report.snapshots} snapshots, ${report.samples} samples, ${report.mismatches} mismatches`);
  if (report.lastParityHash) console.log(`final parity hash: ${report.lastParityHash}`);
  if (report.mismatches > 0 && args.assertHash) {
    console.error(`FAILED: ${report.mismatches} parity mismatches detected`);
    process.exit(1);
  }
}

void main();
