/**
 * Summarizes data/llm-usage.jsonl and projects the monthly cost of the observed load on Ollama Cloud.
 *
 *   npm run llm:usage [-- --since 2026-11-24] [-- --file data/llm-usage.jsonl]
 *
 * Projection = observed tokens per day x 30 at each model's list price. Cached-input discounts are ignored, so it is an
 * upper bound. Prices are USD per million tokens from ollama.com/pricing (2026-11-24); update when they change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { TOKEN_USAGE_FILE, type TokenUsageRecord } from '../src/ollama/tokenUsage.js';

const CLOUD_PRICES: Record<string, { input: number; output: number }> = {
  'nemotron-3-super': { input: 0.015, output: 0.6 },
  'gpt-oss:20b': { input: 0.07, output: 0.3 },
  'beam': { input: 0.125, output: 0.4 },
  'mimo-v2.6-flash': { input: 0.14, output: 0.28 },
  'gemma4': { input: 0.14, output: 0.4 },
  'gpt-oss:120b': { input: 0.15, output: 0.6 },
  'glm-5.3-flash': { input: 0.15, output: 0.5 },
  'deepseek-v4.1-flash': { input: 0.3, output: 1.2 },
};
const DAY_MS = 86_400_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadRecords(file: string, sinceMs: number): TokenUsageRecord[] {
  if (!existsSync(file)) throw new Error(`${file} does not exist yet: start the agent or fleet to record LLM calls`);
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TokenUsageRecord)
    .filter((r) => r.at >= sinceMs);
}

function printBreakdown(records: TokenUsageRecord[]): void {
  const groups = new Map<string, { calls: number; input: number; output: number }>();
  for (const r of records) {
    const key = `${r.source.padEnd(13)} ${r.model.padEnd(22)} ${r.host}`;
    const g = groups.get(key) ?? { calls: 0, input: 0, output: 0 };
    g.calls++;
    g.input += r.promptTokens;
    g.output += r.outputTokens;
    groups.set(key, g);
  }
  console.log('source        model                  host');
  for (const [key, g] of groups) {
    console.log(`${key}\n    ${g.calls} calls | in ${g.input} (avg ${Math.round(g.input / g.calls)}) | out ${g.output} (avg ${Math.round(g.output / g.calls)})`);
  }
}

function printProjection(records: TokenUsageRecord[]): void {
  const spanDays = Math.max((records.at(-1)!.at - records[0]!.at) / DAY_MS, 1 / 24);
  const inputPerDay = records.reduce((s, r) => s + r.promptTokens, 0) / spanDays;
  const outputPerDay = records.reduce((s, r) => s + r.outputTokens, 0) / spanDays;
  console.log(`\nobserved over ${spanDays.toFixed(2)} days: ${(records.length / spanDays).toFixed(0)} calls/day, ${Math.round(inputPerDay)} in + ${Math.round(outputPerDay)} out tokens/day`);
  if (spanDays < 1) console.log('(under a day of data: the projection extrapolates a short window)');
  console.log('\nprojected monthly cost of this load on Ollama Cloud (no cache discount):');
  const rows = Object.entries(CLOUD_PRICES)
    .map(([model, p]) => [model, ((inputPerDay * p.input + outputPerDay * p.output) / 1e6) * 30] as const)
    .sort((a, b) => a[1] - b[1]);
  for (const [model, monthly] of rows) console.log(`  ${model.padEnd(22)} $${monthly.toFixed(2)}`);
}

const file = arg('file') ?? TOKEN_USAGE_FILE;
const since = arg('since');
const records = loadRecords(file, since ? Date.parse(since) : 0);
if (records.length === 0) {
  console.log(`no LLM calls recorded in ${file}${since ? ` since ${since}` : ''}`);
} else {
  printBreakdown(records);
  printProjection(records);
}
