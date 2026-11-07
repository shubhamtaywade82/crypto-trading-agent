/**
 * Pre-registered hypothesis specs for the automated research pipeline.
 *
 * A spec fixes what is tested before any data is read: strategy family, symbols, timeframes, context, parameters, window
 * length, chronological splits, costs and evidence gates. `specHash` is a sha256 over the canonical JSON (keys sorted), so
 * any change to a spec changes its hash, and the OOS ledger can refuse a changed spec on an already-read test window.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const RESEARCH_TIMEFRAMES = ['15m', '1h', '4h'] as const;
export type ResearchTimeframe = (typeof RESEARCH_TIMEFRAMES)[number];

export const splitSchema = z
  .object({ trainPct: z.number().positive(), validationPct: z.number().positive(), testPct: z.number().positive() })
  .refine((s) => Math.abs(s.trainPct + s.validationPct + s.testPct - 100) < 1e-9, { message: 'splits must sum to 100' });

const hypothesisFields = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,79}$/, 'id: uppercase letters, digits, _ or -'),
  version: z.number().int().positive(),
  /** DRAFT specs are skipped unless the runner is told to include them; only REGISTERED specs produce evidence. */
  status: z.enum(['DRAFT', 'REGISTERED', 'RETIRED']),
  hypothesis: z.string().min(10),
  family: z.string().min(2),
  symbols: z.array(z.string().regex(/^[A-Z0-9]{5,20}$/)).min(1),
  timeframes: z.array(z.enum(RESEARCH_TIMEFRAMES)).min(1),
  /** A multi-timeframe rule must be stated here, before the run (e.g. "4h context gates 1h entries"); never searched. */
  timeframeRule: z.string().min(3),
  context: z.object({ id: z.string().min(2), taxonomyVersion: z.string().min(1) }),
  /** Campaign this spec belongs to (research/campaigns/<id>.json); campaign specs share its window and registration budget. */
  campaign: z.string().min(3).optional(),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
  window: z.object({
    days: z.number().positive(),
    endDaysAgo: z.number().min(0).default(0),
    /** Absolute window end. Without it the window slides with the clock, so every run would read a different test set. */
    endIso: z.string().datetime().optional(),
    split: splitSchema,
  }),
  costs: z.object({ roundTripBps: z.number().min(0) }),
  evidence: z.object({
    minOosTrades: z.number().int().min(1).default(100),
    /** Below 0.5: the evaluator's two-sided interval level is 1 - 2*alpha, which must stay in (0, 1). */
    alpha: z.number().gt(0).lt(0.5).default(0.05),
  }),
});

export const hypothesisSpecSchema = hypothesisFields.superRefine((spec, ctx) => {
  if (spec.status === 'REGISTERED' && !spec.window.endIso) {
    ctx.addIssue({ code: 'custom', path: ['window', 'endIso'], message: 'a REGISTERED spec needs window.endIso so its test window is fixed' });
  }
  if (spec.window.endIso && spec.window.endDaysAgo !== 0) {
    ctx.addIssue({ code: 'custom', path: ['window', 'endDaysAgo'], message: 'endDaysAgo must be 0 when window.endIso is set' });
  }
});

export type HypothesisSpec = z.infer<typeof hypothesisSpecSchema>;

/** Deterministic JSON: object keys sorted at every level, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function specHash(spec: HypothesisSpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

export function parseSpec(raw: unknown, source: string): HypothesisSpec {
  const result = hypothesisSpecSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid hypothesis spec ${source}: ${issues}`);
  }
  return result.data;
}

export interface LoadedSpec {
  file: string;
  spec: HypothesisSpec;
  hash: string;
}

/** Loads every *.json in `dir` (non-recursive). Invalid files throw: a broken spec must stop the run, not be skipped. */
export function loadSpecs(dir: string): LoadedSpec[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const loaded = files.map((f) => {
    const file = path.join(dir, f);
    const spec = parseSpec(JSON.parse(readFileSync(file, 'utf8')), file);
    return { file, spec, hash: specHash(spec) };
  });
  const seen = new Map<string, string>();
  for (const { file, spec } of loaded) {
    const key = `${spec.id}@${spec.version}`;
    const prior = seen.get(key);
    if (prior) throw new Error(`duplicate spec ${key} in ${prior} and ${file}`);
    seen.set(key, file);
  }
  return loaded;
}
