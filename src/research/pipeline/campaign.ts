/**
 * Research campaigns: the unit of autonomous exploration.
 *
 * A campaign fixes one window (end, length, split) for every draft it evaluates, so all its drafts share the same train,
 * validation and test boundaries. The agent selects on validation; no draft evaluation computes the test segment, which is
 * read only after a human registers a shortlisted spec. `maxRegistrations` is declared up front and each registered spec
 * must use alpha / maxRegistrations (Bonferroni across specs, Holm within a spec), so the family-wise error over the whole
 * campaign stays at or below `alpha` however many drafts the agent explored on validation.
 *
 * The journal (<id>.journal.jsonl, committed next to the campaign) is the agent's memory across runs and the record of how
 * much selection happened on validation before any test read.
 * ponytail: a campaign file can be edited after registrations; git history is the only guard. Hash it into ledger reads if
 * that ever matters.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RESEARCH_TIMEFRAMES, splitSchema, type HypothesisSpec } from './hypothesis.js';
import type { OosRead } from './oosLedger.js';

export const campaignSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,79}$/, 'id: uppercase letters, digits, _ or -'),
  description: z.string().min(10),
  window: z.object({ endIso: z.string().datetime(), days: z.number().positive(), split: splitSchema }),
  /** Family-wise error budget for every test read the campaign will ever make. */
  alpha: z.number().gt(0).lt(0.5),
  maxRegistrations: z.number().int().min(1),
  /** Cap on draft evaluations (validation reads) over the campaign's life: bounds selection on validation. */
  maxEvaluations: z.number().int().min(1),
  symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)).min(1),
  timeframes: z.array(z.enum(RESEARCH_TIMEFRAMES)).min(1),
});

export type Campaign = z.infer<typeof campaignSchema>;

export function loadCampaign(dir: string, id: string): Campaign {
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`campaign ${id} not found: ${file}`);
  const result = campaignSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success) throw new Error(`invalid campaign ${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (result.data.id !== id) throw new Error(`campaign ${file} declares id ${result.data.id}, expected ${id}`);
  return result.data;
}

/** Per-spec alpha every registered campaign spec must use. */
export const registrationAlpha = (campaign: Campaign): number => campaign.alpha / campaign.maxRegistrations;

export interface SegmentSummary {
  trades: number;
  days: number | null;
  meanR: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  pValue: number | null;
}

export interface SeriesSummary {
  symbol: string;
  timeframe: string;
  train: SegmentSummary;
  validation: SegmentSummary;
}

export type JournalEntry =
  | { kind: 'draft'; atIso: string; runId: string; specId: string; specHash: string }
  | { kind: 'evaluation'; atIso: string; runId: string; specId: string; specHash: string; series: SeriesSummary[] }
  | { kind: 'shortlist'; atIso: string; runId: string; specId: string; specHash: string; rationale: string };

export const journalFileOf = (dir: string, id: string): string => path.join(dir, `${id}.journal.jsonl`);

export function readJournal(file: string): JournalEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line) as JournalEntry;
    } catch {
      throw new Error(`${file}:${i + 1}: unreadable journal line; the journal is append-only and must not be edited by hand`);
    }
  });
}

export function appendJournal(file: string, entry: JournalEntry): void {
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

const sameSplit = (a: Campaign['window']['split'], b: HypothesisSpec['window']['split']): boolean =>
  a.trainPct === b.trainPct && a.validationPct === b.validationPct && a.testPct === b.testPct;

/** Why a spec does not fit its campaign's window, symbols and timeframes; a draft with another window could see the test segment. */
export function shapeProblems(spec: HypothesisSpec, campaign: Campaign): string[] {
  const { window } = campaign;
  const strayTimeframes = spec.timeframes.filter((t) => !campaign.timeframes.includes(t));
  const straySymbols = spec.symbols.filter((s) => !campaign.symbols.includes(s));
  const problems = [
    (spec.window.endIso !== window.endIso || spec.window.days !== window.days || !sameSplit(window.split, spec.window.split))
      && `window must be the campaign window (endIso ${window.endIso}, ${window.days} days, split ${JSON.stringify(window.split)})`,
    straySymbols.length > 0 && `symbols outside the campaign: ${straySymbols.join(',')}`,
    strayTimeframes.length > 0 && `timeframes outside the campaign: ${strayTimeframes.join(',')}`,
  ];
  return problems.filter((p): p is string => typeof p === 'string');
}

/**
 * Why a REGISTERED campaign spec may not be evaluated; empty when it may. Registrations are counted from specs on disk and
 * from ledger reads, so deleting a spec file after its test read does not free budget.
 */
export function registrationProblems(spec: HypothesisSpec, campaign: Campaign, onDisk: HypothesisSpec[], ledger: OosRead[]): string[] {
  const registered = new Set([
    ...onDisk.filter((s) => s.status === 'REGISTERED' && s.campaign === campaign.id).map((s) => s.id),
    ...ledger.filter((read) => read.campaign === campaign.id).map((read) => read.specId),
  ]);
  const problems = [
    ...shapeProblems(spec, campaign),
    spec.evidence.alpha > registrationAlpha(campaign) * (1 + 1e-9) && `evidence.alpha ${spec.evidence.alpha} exceeds the campaign's per-spec alpha ${registrationAlpha(campaign)}`,
    registered.size > campaign.maxRegistrations && `campaign ${campaign.id} has ${registered.size} registered specs, budget ${campaign.maxRegistrations}`,
  ];
  return problems.filter((p): p is string => typeof p === 'string');
}
