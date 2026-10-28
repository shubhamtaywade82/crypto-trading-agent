import fs from 'node:fs';
import path from 'node:path';
import type { MarketBrief } from './types.js';

export const DEFAULT_JOURNAL_DIR = path.resolve('data/market-briefs');

// Appends validated brief payload to audit journal for historical replay
export function appendBriefToJournal(
  brief: MarketBrief,
  journalDir: string = DEFAULT_JOURNAL_DIR
): void {
  fs.mkdirSync(journalDir, { recursive: true });
  const filepath = path.join(journalDir, `${brief.symbol}.jsonl`);
  fs.appendFileSync(filepath, `${JSON.stringify(brief)}\n`, 'utf-8');
}

// Retrieves the most recently recorded brief for change detection baseline
export function readLatestBriefFromJournal(
  symbol: string,
  journalDir: string = DEFAULT_JOURNAL_DIR
): MarketBrief | null {
  const filepath = path.join(journalDir, `${symbol}.jsonl`);
  if (!fs.existsSync(filepath)) return null;

  try {
    const lines = fs.readFileSync(filepath, 'utf-8').trim().split('\n');
    const last = lines.at(-1);
    return last ? (JSON.parse(last) as MarketBrief) : null;
  } catch {
    return null;
  }
}
