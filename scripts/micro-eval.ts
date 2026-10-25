/**
 * Evaluates recorded microstructure readings (MICRO_RECORD=on) against what price did next, after costs.
 *
 *   npm run micro:eval -- [--dir data/microstructure] [--symbols BTCUSDT,SOLUSDT] [--from 2026-10-25] [--to 2026-11-01]
 *                         [--horizons 1,5,30,60] [--fee-bps 4] [--holdout 0.3] [--block-min 15] [--stride 0]
 *                         [--min-n 30] [--iterations 2000] [--seed 1] [--out data/micro-eval/<timestamp>]
 *
 * Writes REPORT.md and results.json to --out and prints the report. See docs/LIQUIDITY_VIEW.md, "Validating".
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_EVAL_CONFIG, evaluate, parseReading, renderReport, type EvalConfig, type RecordedReading } from '../src/microstructure/MicroEval.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${raw}`);
  return n;
};

function main(): void {
  const dir = path.resolve(arg('dir') ?? 'data/microstructure');
  if (!existsSync(dir)) throw new Error(`${dir} does not exist: record with MICRO_RECORD=on first`);
  const from = arg('from');
  const to = arg('to');
  const days = readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!from || d >= from) && (!to || d <= to)).sort();
  if (days.length === 0) throw new Error(`no recorded days in ${dir}${from || to ? ` between ${from ?? '…'} and ${to ?? '…'}` : ''}`);
  const wanted = arg('symbols')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  const bySymbol = new Map<string, { readings: RecordedReading[]; malformed: number }>();
  for (const day of days) {
    for (const file of readdirSync(path.join(dir, day)).filter((f) => f.endsWith('.jsonl'))) {
      const symbol = file.replace(/\.jsonl$/, '');
      if (wanted && !wanted.includes(symbol)) continue;
      const entry = bySymbol.get(symbol) ?? { readings: [], malformed: 0 };
      for (const line of readFileSync(path.join(dir, day, file), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        const r = parseReading(line);
        if (r && r.symbol === symbol) entry.readings.push(r);
        else entry.malformed += 1;
      }
      bySymbol.set(symbol, entry);
    }
  }
  if (bySymbol.size === 0) throw new Error(`no readings for ${wanted?.join(', ') ?? 'any symbol'} in ${dir}`);

  const cfg: EvalConfig = {
    ...DEFAULT_EVAL_CONFIG,
    horizonsMs: (arg('horizons')?.split(',').map((s) => Number(s.trim()) * 1_000) ?? DEFAULT_EVAL_CONFIG.horizonsMs),
    feeBps: num('fee-bps', DEFAULT_EVAL_CONFIG.feeBps),
    holdoutFraction: num('holdout', DEFAULT_EVAL_CONFIG.holdoutFraction),
    blockMs: num('block-min', DEFAULT_EVAL_CONFIG.blockMs / 60_000) * 60_000,
    strideMs: num('stride', 0) * 1_000,
    minN: num('min-n', DEFAULT_EVAL_CONFIG.minN),
    iterations: num('iterations', DEFAULT_EVAL_CONFIG.iterations),
    seed: num('seed', DEFAULT_EVAL_CONFIG.seed),
  };
  if (cfg.horizonsMs.some((h) => !(h > 0))) throw new Error('--horizons must be positive seconds, e.g. 1,5,30,60');
  if (!(cfg.holdoutFraction > 0 && cfg.holdoutFraction < 1)) throw new Error('--holdout must be in (0, 1)');

  const result = evaluate([...bySymbol].sort().map(([symbol, v]) => ({ symbol, ...v })), cfg);
  const report = renderReport(result);
  const out = path.resolve(arg('out') ?? path.join('data/micro-eval', new Date().toISOString().replace(/[:.]/g, '-')));
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'REPORT.md'), report);
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ...result, days, dir }, null, 2));
  console.log(report);
  console.log(`\nWrote ${path.join(out, 'REPORT.md')} and results.json`);
}

try {
  main();
} catch (err) {
  console.error(`micro-eval: ${(err as Error).message}`);
  process.exit(1);
}
