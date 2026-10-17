import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Candle } from '../types.js';
import type { SMCFrame } from '../strategies/smc-ml/types.js';
import type { CalibrationSample } from './calibration.js';
import type { SetupGrade } from './grade.js';
import { resolveOutcome, type OutcomePolicy, type ResolvedOutcome } from './outcome.js';
import { PLAYBOOK_REGISTRY_VERSION } from './registry.js';
import type { PlaybookVerdict, RuleEvaluation, TradeDirection, TradePlan } from './types.js';

/**
 * Append-only JSONL journal of ENTRY_ELIGIBLE playbook decisions and their outcomes. A decision is stored once per
 * setup, with the full rule evidence it was taken on; its outcome is stored once, when it resolves. Loading folds the
 * file back, so a restart never records the same setup or outcome twice.
 */

export interface PlaybookDecisionRecord {
  type: 'decision';
  setupId: string;
  playbookId: string;
  version: number;
  registryVersion: number;
  symbol: string;
  direction: TradeDirection;
  triggerFrame: SMCFrame;
  /** Trigger close: the decision time. */
  decidedAt: number;
  plan: TradePlan;
  grade: SetupGrade | null;
  bucket: string;
  evaluations: RuleEvaluation[];
}

export interface PlaybookOutcomeRecord extends Omit<ResolvedOutcome, 'label'> {
  type: 'outcome';
  setupId: string;
  label: Exclude<ResolvedOutcome['label'], 'UNRESOLVED'>;
  policy: OutcomePolicy;
}

/** One setup per playbook version, symbol, direction and trigger: re-evaluating the same trigger maps to the same id. */
export const setupIdOf = (v: Pick<PlaybookVerdict, 'playbookId' | 'version' | 'symbol' | 'direction' | 'triggeredAt'>): string =>
  `${v.playbookId}@${v.version}:${v.symbol}:${v.direction}:${v.triggeredAt}`;

export class PlaybookJournal {
  private readonly decisionsById = new Map<string, PlaybookDecisionRecord>();
  private readonly outcomesById = new Map<string, PlaybookOutcomeRecord>();
  /** Lines that did not parse on load; kept as a count so corruption is visible instead of silently ignored. */
  readonly skippedLines: number;

  constructor(private readonly file: string) {
    let skipped = 0;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as PlaybookDecisionRecord | PlaybookOutcomeRecord;
          if (record.type === 'decision' && !this.decisionsById.has(record.setupId)) this.decisionsById.set(record.setupId, record);
          else if (record.type === 'outcome' && !this.outcomesById.has(record.setupId)) this.outcomesById.set(record.setupId, record);
          else if (record.type !== 'decision' && record.type !== 'outcome') skipped += 1;
        } catch {
          skipped += 1;
        }
      }
    }
    this.skippedLines = skipped;
  }

  private append(record: PlaybookDecisionRecord | PlaybookOutcomeRecord): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  /** Records an ENTRY_ELIGIBLE verdict once. Returns false for any other verdict or a setup already recorded. */
  recordDecision(v: PlaybookVerdict, triggerFrame: SMCFrame, grade: SetupGrade | null, bucket: string): boolean {
    if (v.verdict !== 'ENTRY_ELIGIBLE' || v.plan === null || v.triggeredAt === null) return false;
    const setupId = setupIdOf(v);
    if (this.decisionsById.has(setupId)) return false;
    const record: PlaybookDecisionRecord = {
      type: 'decision', setupId, playbookId: v.playbookId, version: v.version, registryVersion: PLAYBOOK_REGISTRY_VERSION,
      symbol: v.symbol, direction: v.direction, triggerFrame, decidedAt: v.triggeredAt, plan: v.plan, grade, bucket, evaluations: v.evaluations,
    };
    this.append(record);
    this.decisionsById.set(setupId, record);
    return true;
  }

  /** Records a resolved outcome once, for a recorded decision. UNRESOLVED is never written. */
  recordOutcome(setupId: string, outcome: ResolvedOutcome, policy: OutcomePolicy): boolean {
    if (outcome.label === 'UNRESOLVED' || outcome.resolvedAt === null) return false;
    if (!this.decisionsById.has(setupId) || this.outcomesById.has(setupId)) return false;
    const record: PlaybookOutcomeRecord = { ...outcome, type: 'outcome', setupId, label: outcome.label, policy };
    this.append(record);
    this.outcomesById.set(setupId, record);
    return true;
  }

  decisions(): PlaybookDecisionRecord[] { return [...this.decisionsById.values()]; }
  outcome(setupId: string): PlaybookOutcomeRecord | null { return this.outcomesById.get(setupId) ?? null; }
  pending(): PlaybookDecisionRecord[] { return this.decisions().filter((d) => !this.outcomesById.has(d.setupId)); }

  /**
   * Resolves every pending decision it has candles for. `candlesFor` returns closed trigger-frame candles for a symbol;
   * a decision whose outcome cannot be known yet stays pending. Returns the number of outcomes written.
   */
  resolvePending(candlesFor: (symbol: string, frame: SMCFrame) => readonly Candle[], policy: OutcomePolicy): number {
    let written = 0;
    for (const d of this.pending()) {
      const outcome = resolveOutcome({ direction: d.direction, plan: d.plan, triggeredAt: d.decidedAt, frame: d.triggerFrame, candles: candlesFor(d.symbol, d.triggerFrame) }, policy);
      if (this.recordOutcome(d.setupId, outcome, policy)) written += 1;
    }
    return written;
  }

  /** Decisions joined with their outcomes, as calibration samples. Pending decisions are left out. */
  samples(): CalibrationSample[] {
    return this.decisions().flatMap((d) => {
      const o = this.outcomesById.get(d.setupId);
      return o ? [{ setupId: d.setupId, bucket: d.bucket, decidedAt: d.decidedAt, resolvedAt: o.resolvedAt!, label: o.label, netR: o.netR }] : [];
    });
  }
}
