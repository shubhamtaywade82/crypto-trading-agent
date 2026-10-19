import type { Candle } from '../types.js';
import type { SetupVerdict } from '../decision/SetupTypes.js';
import { analyzeSmcFrame } from '../strategies/smc-ml/SmcMlEngine.js';
import { DEFAULT_SMC_CONFIG, type SMCConfig, type SMCFrame, type SMCFrameAnalysis } from '../strategies/smc-ml/types.js';
import { bucketOf, type BucketDimension } from './calibration.js';
import { closedBars, closeTimeOf, FRAME_MS } from './context.js';
import { evaluatePlaybook } from './evaluate.js';
import { frameConfig, PLAYBOOK_FRAME_OVERRIDES } from './frameConfig.js';
import { gradeVerdict } from './grade.js';
import type { PlaybookJournal } from './journal.js';
import type { OutcomePolicy } from './outcome.js';
import { listPlaybooks } from './registry.js';
import type { ExecutionSnapshot, PlaybookContext, PlaybookDefinition, PlaybookVerdict } from './types.js';

/**
 * Causal replay of the playbooks over history, feeding the journal with exactly the decisions the live engine would
 * have taken:
 *
 * - The clock steps through every trigger-frame close in [from, to].
 * - At each step every frame sees only bars closed by then, windowed to `windowBars` (300, the live runtime's candle
 *   limit), and is re-analysed only when it has a new bar.
 * - A decision is recorded only at its own trigger close (`triggeredAt === now`), the earliest moment it could have been
 *   sent. A setup that becomes eligible only on a later step is not recorded: its entry would be stale.
 * - Outcomes are resolved afterwards from the bars after each trigger; the calibrator's `knownAt` keeps estimates causal.
 *
 * The spread is not in kline data: `execution.spreadBps` is an assumption the caller states and the report prints.
 */

export interface ReplayInput {
  symbol: string;
  /** Full history per frame, including warm-up before `from`. */
  candles: Partial<Record<SMCFrame, readonly Candle[]>>;
  from: number;
  to: number;
  execution: ExecutionSnapshot;
  /**
   * The journal for every playbook that `journalFor` (below) does not cover. Required unless `journalFor` is given:
   * an ablation study passes one journal per variant instead.
   */
  journal?: PlaybookJournal;
  /**
   * One journal per playbook, for an ablation study that replays many variants of the same playbooks in one pass
   * (setup ids collide when variants share a journal). Defaults to `journal` for every playbook.
   */
  journalFor?: (pb: PlaybookDefinition) => PlaybookJournal;
  outcomePolicy: OutcomePolicy;
  playbooks?: readonly PlaybookDefinition[];
  windowBars?: number;
  smcConfig?: SMCConfig;
  /** Per-frame SMC overrides; defaults to the registry's (the 5m trigger swing length). */
  frameOverrides?: Partial<Record<SMCFrame, Partial<SMCConfig>>>;
  bucketDims?: readonly BucketDimension[];
  onProgress?(done: number, total: number): void;
  /** Every verdict, in step order: for audits and causality tests. */
  onVerdict?(v: PlaybookVerdict): void;
}

export interface ReplaySummary {
  steps: number;
  verdicts: Record<SetupVerdict, number>;
  decisionsRecorded: number;
  outcomesWritten: number;
  pendingAfter: number;
  /** Steps at which a frame had too few bars and was left out of the context. */
  warmupSteps: number;
}

interface FrameCache { lastOpen: number; analysis: SMCFrameAnalysis; bars: Candle[] }

export function replayPlaybooks(input: ReplayInput): ReplaySummary {
  if (!input.journal && !input.journalFor) throw new Error('replay needs a journal or a journalFor');
  const playbooks = input.playbooks ?? listPlaybooks();
  const smcConfig = input.smcConfig ?? DEFAULT_SMC_CONFIG;
  const window = input.windowBars ?? 300;
  const overrides = input.frameOverrides ?? PLAYBOOK_FRAME_OVERRIDES;
  const frames = [...new Set(playbooks.flatMap((pb) => [...pb.frames.bias, pb.frames.zone, pb.frames.trigger]))];
  const triggerFrames = [...new Set(playbooks.map((pb) => pb.frames.trigger))];
  if (triggerFrames.length !== 1) throw new Error(`replay needs one trigger frame, got ${triggerFrames.join(', ')}`);
  const step = FRAME_MS[triggerFrames[0]];

  // Validate each full series once (gaps, invalid or conflicting bars abort the replay), then slice per step
  const series = new Map<SMCFrame, Candle[]>();
  for (const frame of frames) {
    const raw = input.candles[frame];
    if (!raw || raw.length === 0) throw new Error(`replay: no ${frame} candles`);
    series.set(frame, closedBars(frame, raw, Number.MAX_SAFE_INTEGER));
  }

  const cache = new Map<SMCFrame, FrameCache>();
  const cursor = new Map<SMCFrame, number>(frames.map((f) => [f, 0]));
  const verdicts: Record<SetupVerdict, number> = { ENTRY_ELIGIBLE: 0, WATCH: 0, NO_TRADE: 0 };
  let decisionsRecorded = 0;
  let warmupSteps = 0;
  const journalOf = input.journalFor ? new Map<PlaybookDefinition, PlaybookJournal>() : null;
  const journalFor = (pb: PlaybookDefinition): PlaybookJournal => {
    if (!journalOf) return input.journal!; // guarded at entry: journal or journalFor is required
    let j = journalOf.get(pb);
    if (!j) { j = input.journalFor!(pb); journalOf.set(pb, j); }
    return j;
  };
  const first = Math.ceil(input.from / step) * step;
  const total = first > input.to ? 0 : Math.floor((input.to - first) / step) + 1;

  for (let i = 0; i < total; i += 1) {
    const now = first + i * step;
    const ctx: PlaybookContext = { symbol: input.symbol, now, candles: {}, frames: {}, dataIssues: {}, execution: input.execution, smcConfig };
    for (const frame of frames) {
      const bars = series.get(frame)!;
      let count = cursor.get(frame)!;
      while (count < bars.length && closeTimeOf(frame, bars[count].openTime) <= now) count += 1;
      cursor.set(frame, count);
      const cfg = frameConfig(smcConfig, frame, overrides);
      const minBars = cfg.swingLength * 2 + 1;
      if (count < minBars) { ctx.dataIssues[frame] = `${count} closed ${frame} bars, need ${minBars}`; continue; }
      const lastOpen = bars[count - 1].openTime;
      let cached = cache.get(frame);
      if (!cached || cached.lastOpen !== lastOpen) {
        const slice = bars.slice(Math.max(0, count - window), count);
        cached = { lastOpen, analysis: analyzeSmcFrame(frame, slice, cfg), bars: slice };
        cache.set(frame, cached);
      }
      ctx.frames[frame] = cached.analysis;
      ctx.candles[frame] = cached.bars;
    }
    if (Object.keys(ctx.dataIssues).length > 0) warmupSteps += 1;

    for (const pb of playbooks) {
      const journal = journalFor(pb);
      for (const direction of ['LONG', 'SHORT'] as const) {
        const v = evaluatePlaybook(pb, ctx, direction);
        verdicts[v.verdict] += 1;
        input.onVerdict?.(v);
        if (v.verdict !== 'ENTRY_ELIGIBLE' || v.triggeredAt !== now) continue;
        const grade = gradeVerdict(v, pb);
        if (journal.recordDecision(v, pb.frames.trigger, grade, bucketOf(v, grade, input.bucketDims))) decisionsRecorded += 1;
      }
    }
    input.onProgress?.(i + 1, total);
  }

  const triggerBars = series.get(triggerFrames[0])!;
  const candlesFor = (symbol: string, frame: SMCFrame) => (symbol === input.symbol && frame === triggerFrames[0] ? triggerBars : []);
  const used = [...new Set(playbooks.map(journalFor))];
  const outcomesWritten = used.reduce((sum, j) => sum + j.resolvePending(candlesFor, input.outcomePolicy), 0);
  return { steps: total, verdicts, decisionsRecorded, outcomesWritten, pendingAfter: used.reduce((sum, j) => sum + j.pending().length, 0), warmupSteps };
}
