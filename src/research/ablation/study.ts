import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FRAME_MS } from '../../playbooks/context.js';
import { PlaybookJournal } from '../../playbooks/journal.js';
import { PLAYBOOK_REGISTRY_VERSION } from '../../playbooks/registry.js';
import { replayPlaybooks } from '../../playbooks/replay.js';
import type { SMCFrame } from '../../strategies/smc-ml/types.js';
import type { PlaybookDefinition } from '../../playbooks/types.js';
import type { Candle } from '../../types.js';
import { holm, utcDay } from '../Bootstrap.js';
import { fingerprintCandles, hashOfConfig } from './fingerprint.js';
import { atrPctAt, computeMetrics, tradesOf } from './metrics.js';
import { costCurve, delayedExpectancy, flipMeanR, permutationTest, segmentBounds, segmentOf, type Segment } from './stats.js';
import { ABLATION_FRAMEWORK_VERSION, type ControlsResult, type ExperimentConfig, type MetricsBundle, type SegmentName, type StudyManifest, type StudyResult, type TradeRecord, type VariantResult, type VariantSpec } from './types.js';
import { buildVariants } from './variants.js';

/**
 * The study runner: one causal replay evaluates every variant; metrics are computed per segment; the selection
 * procedure is fixed before the holdout is read; the family is Holm-corrected; the selected variants get negative
 * controls; and everything needed to reproduce the run is written next to the results.
 *
 * Selection procedure (fixed, versioned with the framework):
 *  1. Eligible on train: filled >= minTrainFilled and train E[R] > 0. Ranked by train bootstrap lower bound.
 *  2. The top `topK` eligible variants are the only ones considered for promotion.
 *  3. Every variant tested is in the Holm family on the holdout: its one-sided bootstrap p-value (H0: E[R] <= 0)
 *     is corrected across the whole family at `alpha`. Searching many variants is exactly why this correction exists.
 *  4. Promoted: considered, holdout n and distinct days met, holdout lower bound > 0, and Holm-rejected.
 * The holdout is read once per study. A study that changes any config value is a new study id and a new holdout read.
 */

export interface StudyInput {
  config: ExperimentConfig;
  /** Full history per frame, including warm-up before `config.from`. */
  candles: Partial<Record<SMCFrame, readonly Candle[]>>;
  /** Output directory for this study; created if missing. */
  outDir: string;
  gitSha?: string | null;
  log?: (line: string) => void;
}

const DAY = 24 * 60 * 60_000;
const fmt = (x: number | null | undefined, d = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const meanOf = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const sanitize = (label: string): string => label.replace(/[^A-Za-z0-9._+-]/g, '_');

const DAY_MS = 24 * 60 * 60_000;

/** The stable study id: symbol, window length and the config hash. Same id = same journals, resumable; new id = new holdout. */
export function studyIdOf(config: ExperimentConfig): string {
  return `${config.symbol}-${Math.round((config.to - config.from) / DAY_MS)}d-${hashOfConfig(config).slice(0, 10)}`;
}

export function runAblationStudy(input: StudyInput): StudyResult {
  const cfg = input.config;
  const log = input.log ?? (() => {});
  if (cfg.version !== 1) throw new Error(`unsupported config version ${cfg.version}`);
  if (!(cfg.from < cfg.to)) throw new Error('config.from must be before config.to');
  if (cfg.playbooks.length === 0) throw new Error('config.playbooks is empty');
  if (cfg.bootstrap.confidence <= 0.5 || cfg.bootstrap.confidence >= 1) throw new Error('bootstrap.confidence must be a one-sided level in (0.5, 1)');

  const startedAt = Date.now();
  const variants = buildVariants(cfg);
  const segments = segmentBounds(cfg.from, cfg.to, cfg.splits);

  const frames = [...new Set(variants.flatMap((v) => [...v.definition.frames.bias, v.definition.frames.zone, v.definition.frames.trigger]))];
  const dataset = frames.map((frame) => {
    const series = input.candles[frame];
    if (!series || series.length === 0) throw new Error(`no candles for frame ${frame}`);
    return fingerprintCandles(frame, series);
  });

  const configHash = hashOfConfig(cfg);
  const studyId = studyIdOf(cfg);
  const outDir = input.outDir;
  mkdirSync(path.join(outDir, 'variants'), { recursive: true });

  const journals = new Map<string, PlaybookJournal>();
  const specOf = new Map<PlaybookDefinition, VariantSpec>();
  for (const v of variants) {
    journals.set(v.label, new PlaybookJournal(path.join(outDir, 'variants', `${sanitize(v.label)}.jsonl`)));
    specOf.set(v.definition, v);
  }
  const journalFor = (pb: PlaybookDefinition): PlaybookJournal => {
    const spec = specOf.get(pb);
    if (!spec) throw new Error('replay evaluated an unknown playbook');
    return journals.get(spec.label)!;
  };

  log(`study ${studyId}: ${variants.length} variants over ${frames.join(', ')}, ${new Date(cfg.from).toISOString()} to ${new Date(cfg.to).toISOString()}`);
  const replayStart = Date.now();
  const replay = replayPlaybooks({
    symbol: cfg.symbol,
    candles: input.candles,
    from: cfg.from,
    to: cfg.to,
    execution: { spreadBps: cfg.execution.spreadBps, takerFeeRate: cfg.execution.takerFeeRate, slippageRate: cfg.execution.slippageRate },
    outcomePolicy: cfg.outcomePolicy,
    playbooks: variants.map((v) => v.definition),
    journalFor,
    windowBars: cfg.windowBars,
    onProgress: (done, total) => {
      if (done % 2000 === 0 || done === total) log(`  step ${done}/${total}`);
    },
  });
  const replayMs = Date.now() - replayStart;
  log(`  replay: ${replay.steps} steps, ${replay.decisionsRecorded} decisions, ${replay.outcomesWritten} outcomes in ${(replayMs / 1000).toFixed(1)} s`);

  const triggerFrame = variants[0].definition.frames.trigger;
  const triggerMs = FRAME_MS[triggerFrame];
  const triggerCandles: readonly Candle[] = input.candles[triggerFrame] ?? [];
  if (triggerCandles.length === 0) throw new Error(`no ${triggerFrame} candles`);

  const zoneFrameOf = (spec: VariantSpec): SMCFrame => spec.definition.frames.zone;

  const tradesByLabel = new Map<string, TradeRecord[]>();
  const pendingByLabel = new Map<string, Record<SegmentName | 'full', number>>();
  for (const v of variants) {
    const journal = journals.get(v.label)!;
    const zoneFrame = zoneFrameOf(v);
    const trades = tradesOf({
      decisions: journal.decisions(),
      outcomeOf: (setupId) => journal.outcome(setupId),
      triggerFrame,
      triggerCandles,
      zoneCandles: input.candles[zoneFrame] ?? null,
      zoneFrame,
      policy: cfg.outcomePolicy,
    });
    const pendingBySegment: Record<SegmentName | 'full', number> = { full: journal.pending().length, train: 0, validation: 0, holdout: 0 };
    for (const d of journal.pending()) {
      const seg = segmentOf(d.decidedAt, segments);
      if (seg) pendingBySegment[seg] += 1;
    }
    tradesByLabel.set(v.label, trades);
    pendingByLabel.set(v.label, pendingBySegment);
  }

  /** Zone-frame ATR14 over price at the decision time. Memoized per decision time: the zone series is shared by every variant. */
  const atrPctCache = new Map<number, number | null>();
  const atrPctOfVariant = (spec: VariantSpec) => (t: { decidedAt: number }): number | null => {
    const zoneFrame = zoneFrameOf(spec);
    const key = t.decidedAt;
    if (!atrPctCache.has(key)) {
      const zoneCandles = input.candles[zoneFrame];
      atrPctCache.set(key, zoneCandles ? atrPctAt(zoneCandles, zoneFrame, t.decidedAt) : null);
    }
    return atrPctCache.get(key) ?? null;
  };

  const bundleByLabel = new Map<string, MetricsBundle>();
  for (const v of variants) {
    const trades = tradesByLabel.get(v.label)!;
    const pendingBySegment = pendingByLabel.get(v.label)!;
    const m = (name: SegmentName | 'full') => {
      const subset = name === 'full' ? trades : trades.filter((t) => segmentOf(t.decidedAt, segments) === name);
      return computeMetrics(subset, cfg, { bootstrapSeed: cfg.bootstrap.seed, pending: pendingBySegment[name], triggerFrameMs: triggerMs, atrPctOf: atrPctOfVariant(v) });
    };
    bundleByLabel.set(v.label, { full: m('full'), train: m('train'), validation: m('validation'), holdout: m('holdout') });
  }

  // Selection: rank eligible variants on train, then read the holdout once for the whole family
  const ranking = variants
    .map((v) => ({ spec: v, bundle: bundleByLabel.get(v.label)! }))
    .filter(({ bundle }) => bundle.train.filled >= cfg.selection.minTrainFilled && (bundle.train.evR ?? -Infinity) > 0)
    .sort((a, b) => {
      const lbA = a.bundle.train.bootstrap?.ciLow ?? -Infinity;
      const lbB = b.bundle.train.bootstrap?.ciLow ?? -Infinity;
      if (lbA !== lbB) return lbB - lbA;
      const evA = a.bundle.train.evR ?? -Infinity;
      const evB = b.bundle.train.evR ?? -Infinity;
      if (evA !== evB) return evB - evA;
      return a.spec.label < b.spec.label ? -1 : 1;
    })
    .slice(0, cfg.selection.topK)
    .map((x) => x.spec.label);
  const selected = new Set(ranking);

  const familyP: { label: string; p: number | null }[] = variants.map((v) => ({
    label: v.label,
    p: bundleByLabel.get(v.label)!.holdout.bootstrap?.pValue ?? null,
  }));
  const tested = familyP.filter((x) => x.p !== null);
  const rejects = holm(tested.map((x) => x.p!), cfg.selection.alpha);
  const holmRejected = new Map<string, boolean>();
  tested.forEach((x, i) => holmRejected.set(x.label, rejects[i]));

  const results: VariantResult[] = variants.map((v) => {
    const bundle = bundleByLabel.get(v.label)!;
    const reasons: string[] = [];
    const train = bundle.train;
    if (train.filled < cfg.selection.minTrainFilled) reasons.push(`train filled ${train.filled} < ${cfg.selection.minTrainFilled}`);
    else if (!(train.evR !== null && train.evR > 0)) reasons.push('train E[R] is not positive');
    else if (!selected.has(v.label)) reasons.push(`not in the top-${cfg.selection.topK} by train lower bound`);
    else {
      if (bundle.validation.filled < cfg.selection.minValidationFilled) reasons.push(`validation filled ${bundle.validation.filled} < ${cfg.selection.minValidationFilled}`);
      else if (!(bundle.validation.evR !== null && bundle.validation.evR > 0)) reasons.push('validation E[R] is not positive');
    }
    const holdoutDays = new Set(tradesByLabel.get(v.label)!.filter((t) => segmentOf(t.decidedAt, segments) === 'holdout' && t.netR !== null).map((t) => utcDay(t.decidedAt))).size;
    const lb = bundle.holdout.bootstrap?.ciLow ?? null;
    const rejected = holmRejected.get(v.label) ?? false;
    if (selected.has(v.label) && reasons.length === 0) {
      if (bundle.holdout.filled < cfg.selection.minHoldoutFilled) reasons.push(`holdout filled ${bundle.holdout.filled} < ${cfg.selection.minHoldoutFilled}`);
      if (holdoutDays < cfg.selection.minDays) reasons.push(`holdout days ${holdoutDays} < ${cfg.selection.minDays}`);
      if (lb === null || !(lb > 0)) reasons.push('holdout bootstrap lower bound is not positive');
      if (!rejected) reasons.push(`not Holm-rejected at alpha ${cfg.selection.alpha} across ${tested.length} variants`);
    }
    const promoted = reasons.length === 0;
    const controls = promoted || (selected.has(v.label) && bundle.holdout.filled >= 2) ? controlsFor(v, bundle) : null;
    return {
      spec: v,
      definitionHash: hashOfConfig(v.definition),
      metrics: bundle,
      controls,
      selection: { considered: selected.has(v.label), reasons: promoted ? ['met every promotion requirement'] : reasons, holmRejected: holmRejected.get(v.label) ?? null, promoted },
    };
  });

  function controlsFor(v: VariantSpec, bundle: MetricsBundle): ControlsResult {
    const journal = journals.get(v.label)!;
    const basis: SegmentName | 'full' = bundle.holdout.filled >= 2 ? 'holdout' : 'full';
    const basisTrades = tradesByLabel.get(v.label)!.filter((t) => (basis === 'full' ? true : segmentOf(t.decidedAt, segments) === basis));
    const basisDecisions = journal.decisions().filter((d) => (basis === 'full' ? true : segmentOf(d.decidedAt, segments) === basis));
    const rs = basisTrades.filter((t) => t.netR !== null).map((t) => t.netR!);
    const observed = meanOf(rs);
    const perm = permutationTest(rs, cfg.permutations, cfg.bootstrap.seed + 1);
    const delay = cfg.delayBars.map((bars) => {
      const de = delayedExpectancy(basisDecisions, triggerFrame, triggerCandles, cfg.outcomePolicy, bars);
      return { ...de, deltaR: de.evR === null || observed === null ? null : de.evR - observed };
    });
    const costs = costCurve(basisDecisions, triggerFrame, triggerCandles, cfg.outcomePolicy, cfg.costMultipliers);
    return {
      basis,
      flipMeanR: flipMeanR(basisTrades),
      permutation: { ...perm, observedMeanR: observed },
      delay,
      costs,
    };
  }

  const promotedCount = results.filter((r) => r.selection.promoted).length;
  const selectionSummary = promotedCount > 0
    ? `${promotedCount} of ${variants.length} variants met every promotion requirement on the holdout.`
    : ranking.length === 0
      ? `No variant reached ${cfg.selection.minTrainFilled} filled train trades with positive E[R]; the holdout stays unread for promotion (it was only scanned for the Holm family).`
      : `None of the top-${cfg.selection.topK} train candidates passed validation, holdout evidence and the Holm gate together.`;

  const finishedAt = Date.now();
  const manifest: StudyManifest = {
    frameworkVersion: ABLATION_FRAMEWORK_VERSION,
    studyId,
    configHash,
    config: cfg,
    dataset,
    code: {
      gitSha: input.gitSha ?? null,
      playbookRegistryVersion: PLAYBOOK_REGISTRY_VERSION,
      nodeVersion: process.version,
    },
    seeds: { bootstrap: cfg.bootstrap.seed, permutation: cfg.bootstrap.seed + 1 },
    startedAt,
    finishedAt,
    variantCount: variants.length,
    replay: { steps: replay.steps, warmupSteps: replay.warmupSteps, decisionsRecorded: replay.decisionsRecorded, outcomesWritten: replay.outcomesWritten, durationMs: replayMs },
  };

  const result: StudyResult = {
    manifest,
    variants: results,
    selection: {
      ranking: ranking.map((label) => {
        const b = bundleByLabel.get(label)!;
        return { label, trainFilled: b.train.filled, trainEvR: b.train.evR, trainLowerBoundR: b.train.bootstrap?.ciLow ?? null, selected: true };
      }),
      holm: { alpha: cfg.selection.alpha, familySize: tested.length, rejections: rejects.filter(Boolean).length },
      summary: selectionSummary,
    },
  };

  writeFileSync(path.join(outDir, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'REPORT.md'), reportMd(result, segments));
  log(`  wrote ${outDir}/REPORT.md, results.json, manifest.json, config.json and ${variants.length} variant journals`);
  return result;
}

/** Human-readable report of the study. */
export function reportMd(result: StudyResult, segments: readonly Segment[]): string {
  const m = result.manifest;
  const cfg = m.config;
  const iso = (t: number): string => new Date(t).toISOString().replace('.000Z', 'Z');
  const lines: string[] = [];
  lines.push(`# SMC/ICT component ablation — ${cfg.symbol}`);
  lines.push('');
  lines.push(`Study \`${m.studyId}\`, ablation framework v${m.frameworkVersion}, playbook registry v${m.code.playbookRegistryVersion}${m.code.gitSha ? `, commit \`${m.code.gitSha.slice(0, 10)}\`` : ''}, node ${m.code.nodeVersion}.`);
  lines.push('');
  lines.push(`- Window: ${iso(cfg.from)} to ${iso(cfg.to)} (${Math.round((cfg.to - cfg.from) / DAY)} days), data source \`${cfg.source}\``);
  lines.push(`- Segments: ${segments.map((s) => `${s.name} ${iso(s.start)}..${iso(s.end)}`).join(', ')}`);
  lines.push(`- Costs: spread ${cfg.execution.spreadBps} bps (assumed, klines carry no spread), taker fee ${(cfg.execution.takerFeeRate * 10_000).toFixed(1)} bps, slippage ${(cfg.execution.slippageRate * 10_000).toFixed(1)} bps per side`);
  lines.push(`- Outcome policy: limit TTL ${cfg.outcomePolicy.entryTtlBars} bars, horizon ${cfg.outcomePolicy.horizonBars} bars, stop tested before target within a bar`);
  lines.push(`- Research param overrides applied to every variant: ${Object.keys(cfg.paramOverrides).length > 0 ? `\`${JSON.stringify(cfg.paramOverrides)}\`` : 'none'}`);
  lines.push(`- Seeds: bootstrap ${m.seeds.bootstrap}, permutation ${m.seeds.permutation}; bootstrap confidence ${cfg.bootstrap.confidence} (one-sided), ${cfg.bootstrap.iterations} iterations`);
  lines.push(`- Dataset: ${m.dataset.map((d) => `${d.frame} ${d.bars} bars sha256:${d.sha256.slice(0, 12)}`).join(', ')}`);
  lines.push(`- Variants: ${m.variantCount}; replay ${m.replay.steps} steps, ${m.replay.decisionsRecorded} decisions, ${m.replay.outcomesWritten} outcomes in ${(m.replay.durationMs / 1000).toFixed(1)} s`);
  lines.push(`- Selection: ${result.selection.summary}`);
  lines.push('');
  lines.push('## Holdout results (all variants)');
  lines.push('');
  lines.push('| variant | components | n | fill | E[R] | LB | PF | win | p(holdout) | Holm | verdict |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  const order = [...result.variants].sort((a, b) => Number(b.selection.promoted) - Number(a.selection.promoted) || Number(b.selection.considered) - Number(a.selection.considered) || a.spec.label.localeCompare(b.spec.label));
  for (const v of order) {
    const h = v.metrics.holdout;
    lines.push(`| ${v.spec.name} | ${v.spec.components.join(', ') || 'core only'} | ${h.filled} | ${pct(h.fillRate)} | ${fmt(h.evR)} | ${fmt(h.bootstrap?.ciLow ?? null)} | ${fmt(h.profitFactor, 2)} | ${pct(h.winRate)} | ${v.selection.holmRejected === null ? 'n/a' : fmt(v.metrics.holdout.bootstrap?.pValue ?? null, 4)} | ${v.selection.holmRejected === null ? 'n/a' : v.selection.holmRejected ? 'reject' : 'no'} | ${v.selection.promoted ? 'PROMOTED' : v.selection.reasons[0]} |`);
  }
  lines.push('');
  lines.push('## Train evidence (selection input)');
  lines.push('');
  lines.push('| variant | train filled | train E[R] | train LB |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const r of result.selection.ranking) lines.push(`| ${r.label} | ${r.trainFilled} | ${fmt(r.trainEvR)} | ${fmt(r.trainLowerBoundR)} |`);
  if (result.selection.ranking.length === 0) lines.push('| (none eligible) | | | |');
  lines.push('');
  for (const v of result.variants.filter((x) => x.controls !== null)) {
    const c = v.controls!;
    const h = v.metrics.holdout;
    lines.push(`## Controls: ${v.spec.label} (${c.basis} basis, ${h.filled} filled)`);
    lines.push('');
    lines.push(`- Mirror (flip) null mean: ${fmt(c.flipMeanR)} R — a timing edge should invert to roughly minus the observed mean.`);
    lines.push(`- Sign-flip permutation: observed ${fmt(c.permutation.observedMeanR)} R, null p95 ${fmt(c.permutation.nullP95R)} R, p = ${fmt(c.permutation.pValue, 4)} over ${c.permutation.iterations} iterations.`);
    lines.push(`- Delayed entries: ${c.delay.map((d) => `+${d.bars} bars n=${d.n} E[R]=${fmt(d.evR)} (Δ ${fmt(d.deltaR)})`).join('; ')} — a real timing edge decays with delay.`);
    lines.push(`- Cost curve: ${c.costs.map((c2) => `×${c2.multiplier} n=${c2.n} E[R]=${fmt(c2.evR)}`).join('; ')} — the edge must survive multiplied fee+slippage to matter.`);
    lines.push('');
  }
  lines.push('## Reading notes');
  lines.push('');
  lines.push('- Decisions are causal: every verdict uses only bars closed at its trigger close, entries are limits at the zone edge resting for the TTL, and within a bar the stop is tested before the target.');
  lines.push('- The spread is an assumption, not an observation: kline data carries no spread. Treat the cost curve as the sensitivity read.');
  lines.push('- Metrics are net R per unit of filled risk after taker fee and slippage on both legs; funding is not modelled.');
  lines.push('- A PROMOTED variant is a research candidate, not a live signal: the live admission gate (calibration.ts DEFAULT_ADMISSION_POLICY: 200 outcomes, 20 days, E[R] lower bound > 0.05 R) still applies before anything trades.');
  lines.push('- The holdout was read once for this config hash. Any config change is a new study id; re-reading the same holdout across config variations is exactly the selection bias this framework exists to prevent.');
  lines.push('');
  return lines.join('\n');
}
