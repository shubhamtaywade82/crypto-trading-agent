/**
 * Replays recorded native klines (5m / 15m / 1h / 1m) through the liquidity rejection zone engine.
 * Read-only: nothing is written unless --json is given.
 *
 *   npx tsx scripts/rejection-zones-replay.ts [--dir research-data/binance-usdm/delta] [--file <one.jsonl>]
 *                                             [--symbol SOLUSDT] [--json <out.json>]
 *
 * Each JSONL line is a closed kline: {symbol, interval, openTime, open, high, low, close, volume, quoteVolume,
 * trades, takerBuyBase}. Lines are de-duplicated by (symbol, interval, openTime). Conflicting copies are excluded and
 * reported, the same rule the 1m ingestion uses. Malformed lines are counted and skipped.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { flowBarFromKline } from '../src/market/rejection/bars.js';
import { analyzeTimeframe, resolveEngineConfig, type TimeframeAnalysis } from '../src/market/rejection/engine.js';
import { REJECTION_TIMEFRAMES, type FlowBar, type RejectionTimeframe } from '../src/market/rejection/types.js';

interface RecordedKline {
  symbol: string;
  interval: string;
  openTime: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
  quoteVolume: string | number;
  trades: number;
  takerBuyBase: string | number;
}

interface Group {
  symbol: string;
  timeframe: RejectionTimeframe;
  bars: FlowBar[];
  duplicates: number;
  conflicts: number;
  analysis: TimeframeAnalysis;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function listInputs(): string[] {
  const file = arg('file');
  if (file) return [file];
  const dir = arg('dir') ?? 'research-data/binance-usdm/delta';
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}

function main(): void {
  const symbolFilter = arg('symbol');
  const inputs = listInputs();
  const bySeries = new Map<string, Map<number, FlowBar>>();
  const conflictKeys = new Map<string, Set<number>>();
  const parseRejects: Record<string, number> = {};
  const duplicates = new Map<string, number>();
  let lines = 0;

  for (const file of inputs) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      let rec: RecordedKline;
      try {
        rec = JSON.parse(line) as RecordedKline;
      } catch {
        parseRejects.MALFORMED_JSON = (parseRejects.MALFORMED_JSON ?? 0) + 1;
        continue;
      }
      if (symbolFilter && rec.symbol !== symbolFilter) continue;
      if (!(REJECTION_TIMEFRAMES as readonly string[]).includes(rec.interval)) {
        parseRejects.UNSUPPORTED_INTERVAL = (parseRejects.UNSUPPORTED_INTERVAL ?? 0) + 1;
        continue;
      }
      const tf = rec.interval as RejectionTimeframe;
      const converted = flowBarFromKline(rec.symbol, tf, rec);
      if (!converted.ok) {
        parseRejects[converted.reason] = (parseRejects[converted.reason] ?? 0) + 1;
        continue;
      }

      const key = `${rec.symbol}|${tf}`;
      const series = bySeries.get(key) ?? new Map<number, FlowBar>();
      bySeries.set(key, series);
      const conflicts = conflictKeys.get(key) ?? new Set<number>();
      conflictKeys.set(key, conflicts);
      if (conflicts.has(rec.openTime)) continue;

      const prior = series.get(rec.openTime);
      if (!prior) {
        series.set(rec.openTime, converted.bar);
      } else if (JSON.stringify(prior) === JSON.stringify(converted.bar)) {
        duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
      } else {
        series.delete(rec.openTime);
        conflicts.add(rec.openTime);
      }
    }
  }

  const groups: Group[] = [];
  for (const [key, series] of [...bySeries].sort(([a], [b]) => a.localeCompare(b))) {
    const [symbol, tf] = key.split('|') as [string, RejectionTimeframe];
    const bars = [...series.values()].sort((a, b) => a.openTime - b.openTime);
    const analysis = analyzeTimeframe(bars, tf, resolveEngineConfig());
    groups.push({
      symbol,
      timeframe: tf,
      bars,
      duplicates: duplicates.get(key) ?? 0,
      conflicts: conflictKeys.get(key)?.size ?? 0,
      analysis,
    });
  }

  console.log(`inputs: ${inputs.length} file(s), ${lines} line(s)`);
  console.log(`parse rejects: ${JSON.stringify(parseRejects)}`);
  for (const g of groups) {
    const statuses = countBy(g.analysis.events.map((e) => e.status));
    const zoneStatuses = countBy(g.analysis.zones.map((z) => z.status));
    console.log(
      `\n${g.symbol} ${g.timeframe}: bars=${g.bars.length} duplicates=${g.duplicates} conflicts=${g.conflicts}`
      + ` events=${JSON.stringify(statuses)} zones=${g.analysis.zones.length} ${JSON.stringify(zoneStatuses)}`,
    );
    const top = [...g.analysis.zones].sort((a, b) => b.strength.score - a.strength.score).slice(0, 5);
    for (const z of top) {
      console.log(
        `  ${z.direction.padEnd(6)} [${z.lowerBound}, ${z.upperBound}] ${z.status.padEnd(10)} score=${z.strength.score}`
        + ` rejections=${z.rejectionCount} tests=${z.testCount}`,
      );
    }
  }

  const jsonPath = arg('json');
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify({ inputs, parseRejects, groups }, null, 2)}\n`);
    console.log(`\nwrote ${jsonPath}`);
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
