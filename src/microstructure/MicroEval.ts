import { bootstrapMean, holm, type BootstrapSummary } from '../research/Bootstrap.js';

/**
 * Offline evaluation of recorded microstructure readings (MICRO_RECORD=on): integrity of the recording, then each
 * reading labelled with the mid move over fixed horizons, net of round-trip costs, sliced by the conditions the
 * Liquidity view shows. Directions are fixed in code before looking at outcomes, so a sign cannot be chosen after the
 * fact. Inference uses a cluster bootstrap over time blocks, because one-second readings overlap heavily, and a
 * chronological train/holdout split with Holm correction across every directional cell.
 */

/** One recorded line, read loosely: older recordings lack `windows` and `bias`. */
export interface RecordedReading {
  symbol: string;
  t: number;
  book: { status: string };
  mid: number | null;
  spreadBps: number | null;
  phase?: string;
  windows?: Array<{ ms: number; phase: string; ofi: number | null; complete?: boolean }>;
  friction?: { status: string; buySlipBps: number | null; sellSlipBps: number | null };
  evidence?: string;
  bias?: { bias: string };
}

export interface EvalConfig {
  horizonsMs: number[];
  /** Taker fee per side, bps. */
  feeBps: number;
  /** Final share of the time range held out; the rest is training. */
  holdoutFraction: number;
  /** Bootstrap cluster: one per symbol per block of this length. */
  blockMs: number;
  /** Consecutive readings further apart than this start a new segment. */
  gapMs: number;
  /** A forward mid may land at most this late after t + horizon. */
  toleranceMs: number;
  /** Keep at most one reading per symbol per stride (0 keeps all). */
  strideMs: number;
  minN: number;
  minClusters: number;
  iterations: number;
  seed: number;
  confidence: number;
  alpha: number;
  /** Look-back for the realized-volatility regime. */
  volLookbackMs: number;
}

export const DEFAULT_EVAL_CONFIG: EvalConfig = {
  horizonsMs: [1_000, 5_000, 30_000, 60_000], feeBps: 4, holdoutFraction: 0.3, blockMs: 15 * 60_000, gapMs: 3_000, toleranceMs: 1_500,
  strideMs: 0, minN: 30, minClusters: 5, iterations: 2_000, seed: 1, confidence: 0.9, alpha: 0.05, volLookbackMs: 5 * 60_000,
};

export type Split = 'train' | 'holdout';
export type VolRegime = 'low' | 'mid' | 'high';

export interface IntegrityReport {
  symbol: string;
  lines: number;
  malformed: number;
  duplicates: number;
  outOfOrder: number;
  live: number;
  statuses: Record<string, number>;
  segments: number;
  gaps: number;
  longestGapMs: number;
  firstT: number | null;
  lastT: number | null;
}

/** A live reading inside a contiguous live segment, with its forward moves. */
export interface LabelledReading {
  r: RecordedReading;
  split: Split;
  /** Forward mid move in bps per horizon; null when no forward mid exists inside the same live segment. */
  forwardBps: Array<number | null>;
  /** Round-trip cost in bps; null when the reading carries neither slippage nor spread. */
  costBps: number | null;
  /** True for the first reading after the persisted bias changed. */
  biasOnset: boolean;
  /** Realized volatility before the reading, bps per sqrt-second; null with too little history. */
  vol: number | null;
  regime: VolRegime | null;
  cluster: string;
}

export interface CellStats {
  summary: BootstrapSummary | null;
  /** Mean of direction x forward move before costs. */
  grossMean: number | null;
}

export interface DirectionalCell {
  condition: string;
  /** +1 long, -1 short: fixed in code. */
  direction: 1 | -1;
  horizonMs: number;
  train: CellStats;
  holdout: CellStats;
  /** Holdout by volatility regime (thresholds from training). */
  byRegime: Record<VolRegime, CellStats>;
  holmRejected: boolean;
  verdict: 'PASS' | 'FAIL' | 'INSUFFICIENT';
}

export interface BaselineCell {
  condition: string;
  horizonMs: number;
  /** Mean forward move (no direction, no cost), all splits. */
  n: number;
  meanBps: number | null;
}

export interface CostProfile {
  status: string;
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

export interface EvalResult {
  config: EvalConfig;
  integrity: IntegrityReport[];
  splitAt: number | null;
  labelled: number;
  coverage: Array<{ horizonMs: number; labelled: number }>;
  directional: DirectionalCell[];
  baselines: BaselineCell[];
  costs: CostProfile[];
  ofiQuintiles: Record<number, number[]>;
  volThresholds: [number, number] | null;
}

// ---- parsing & integrity -----------------------------------------------------------------------------------------

/** Null for a line that is not a usable reading. */
export function parseReading(line: string): RecordedReading | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = raw as Partial<RecordedReading>;
  if (typeof r?.symbol !== 'string' || typeof r.t !== 'number' || !Number.isFinite(r.t) || typeof r.book?.status !== 'string') return null;
  if (r.mid !== null && r.mid !== undefined && !(typeof r.mid === 'number' && r.mid > 0)) return null;
  // Keep only what the evaluation reads: recorded lines also carry events, raw flow and depth, and a week of
  // one-second readings for four symbols would not fit in memory with them.
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    symbol: r.symbol,
    t: r.t,
    book: { status: r.book.status },
    mid: r.mid ?? null,
    spreadBps: num(r.spreadBps),
    ...(typeof r.phase === 'string' ? { phase: r.phase } : {}),
    ...(Array.isArray(r.windows) ? { windows: r.windows.map((w) => ({ ms: w.ms, phase: w.phase, ofi: num(w.ofi) })) } : {}),
    ...(r.friction && typeof r.friction.status === 'string' ? { friction: { status: r.friction.status, buySlipBps: num(r.friction.buySlipBps), sellSlipBps: num(r.friction.sellSlipBps) } } : {}),
    ...(typeof r.evidence === 'string' ? { evidence: r.evidence } : {}),
    ...(r.bias && typeof r.bias.bias === 'string' ? { bias: { bias: r.bias.bias } } : {}),
  };
}

const isLive = (r: RecordedReading) => r.book.status === 'LIVE' && r.mid !== null;

/**
 * Sorts, drops exact-time duplicates and splits into contiguous live segments: a gap longer than `gapMs` or any
 * non-live reading ends a segment, so no label ever spans a recording gap or a book that was not trustworthy.
 */
export function segmentReadings(symbol: string, readings: RecordedReading[], malformed: number, gapMs: number): { segments: RecordedReading[][]; integrity: IntegrityReport } {
  let outOfOrder = 0;
  for (let i = 1; i < readings.length; i += 1) if (readings[i].t < readings[i - 1].t) outOfOrder += 1;
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  const unique: RecordedReading[] = [];
  let duplicates = 0;
  for (const r of sorted) {
    if (unique.length && unique[unique.length - 1].t === r.t) duplicates += 1;
    else unique.push(r);
  }
  const statuses: Record<string, number> = {};
  for (const r of unique) statuses[r.book.status] = (statuses[r.book.status] ?? 0) + 1;

  const segments: RecordedReading[][] = [];
  let current: RecordedReading[] = [];
  let gaps = 0;
  let longestGapMs = 0;
  for (let i = 0; i < unique.length; i += 1) {
    const r = unique[i];
    if (i > 0) {
      const dt = r.t - unique[i - 1].t;
      if (dt > gapMs) { gaps += 1; longestGapMs = Math.max(longestGapMs, dt); }
      if (dt > gapMs || !isLive(r)) {
        if (current.length) segments.push(current);
        current = [];
      }
    }
    if (isLive(r)) current.push(r);
  }
  if (current.length) segments.push(current);
  return {
    segments,
    integrity: {
      symbol, lines: readings.length + malformed, malformed, duplicates, outOfOrder, live: unique.filter(isLive).length, statuses,
      segments: segments.length, gaps, longestGapMs, firstT: unique[0]?.t ?? null, lastT: unique[unique.length - 1]?.t ?? null,
    },
  };
}

// ---- labelling ---------------------------------------------------------------------------------------------------

/** Round trip from mid: measured buy + sell slippage for the recorded order size, else the spread; plus two fees. */
export function roundTripCostBps(r: RecordedReading, feeBps: number): number | null {
  const f = r.friction;
  if (f && f.buySlipBps !== null && f.sellSlipBps !== null && Number.isFinite(f.buySlipBps) && Number.isFinite(f.sellSlipBps)) return f.buySlipBps + f.sellSlipBps + 2 * feeBps;
  if (r.spreadBps !== null && Number.isFinite(r.spreadBps)) return r.spreadBps + 2 * feeBps;
  return null;
}

/** Realized volatility (bps per sqrt-second) of mid log returns over the look-back, within the segment; null when short. */
function rollingVol(segment: RecordedReading[], lookbackMs: number): Array<number | null> {
  const out: Array<number | null> = new Array(segment.length).fill(null);
  const rets: Array<{ t: number; r2: number; dt: number }> = [];
  let sum = 0;
  let sumDt = 0;
  let start = 0;
  for (let i = 1; i < segment.length; i += 1) {
    const r = Math.log((segment[i].mid as number) / (segment[i - 1].mid as number)) * 10_000;
    const dt = (segment[i].t - segment[i - 1].t) / 1_000;
    rets.push({ t: segment[i].t, r2: r * r, dt });
    sum += r * r;
    sumDt += dt;
    while (start < rets.length && rets[start].t <= segment[i].t - lookbackMs) { sum -= rets[start].r2; sumDt -= rets[start].dt; start += 1; }
    if (rets.length - start >= 60 && sumDt > 0) out[i] = Math.sqrt(sum / sumDt);
  }
  return out;
}

export function labelSegment(segment: RecordedReading[], cfg: EvalConfig, splitAt: number): LabelledReading[] {
  const out: LabelledReading[] = [];
  const vol = rollingVol(segment, cfg.volLookbackMs);
  const pointers = cfg.horizonsMs.map(() => 0);
  let lastKept = -Infinity;
  for (let i = 0; i < segment.length; i += 1) {
    const r = segment[i];
    const onset = i > 0 && r.bias?.bias !== undefined && segment[i - 1].bias?.bias !== undefined && r.bias.bias !== segment[i - 1].bias!.bias;
    const forwardBps = cfg.horizonsMs.map((h, k) => {
      let j = Math.max(pointers[k], i + 1);
      while (j < segment.length && segment[j].t < r.t + h) j += 1;
      pointers[k] = j;
      if (j >= segment.length || segment[j].t - (r.t + h) > cfg.toleranceMs) return null;
      return (((segment[j].mid as number) - (r.mid as number)) / (r.mid as number)) * 10_000;
    });
    // Stride thinning keeps onsets as well: they are rare and the least overlapping observations there are. Only
    // readings kept on the stride grid move the grid, so onsets never shift it.
    const onGrid = cfg.strideMs <= 0 || r.t - lastKept >= cfg.strideMs;
    if (!onGrid && !onset) continue;
    if (onGrid) lastKept = r.t;
    out.push({
      r, forwardBps, biasOnset: onset, costBps: roundTripCostBps(r, cfg.feeBps), regime: null, vol: vol[i],
      split: r.t < splitAt ? 'train' : 'holdout', cluster: `${r.symbol}:${Math.floor(r.t / cfg.blockMs)}`,
    });
  }
  return out;
}

// ---- conditions --------------------------------------------------------------------------------------------------

/** Fixed hypothesis directions (the same mappings the micro bias uses); anything else is reported only as a baseline. */
export const PHASE_DIRECTION: Record<string, 1 | -1 | 0> = {
  INITIATIVE_BUYING: 1, SELL_ABSORBED: 1, INITIATIVE_SELLING: -1, BUY_ABSORBED: -1, DRIFT_UP: 0, DRIFT_DOWN: 0, BALANCED: 0, THIN: 0,
};

interface Condition {
  name: string;
  direction: 1 | -1 | 0;
  test: (l: LabelledReading) => boolean;
}

const windowLabel = (ms: number) => (ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1_000}s`);

function quintiles(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map((q) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]);
}

function ofiBucket(value: number, cuts: number[]): number {
  let b = 1;
  for (const c of cuts) if (value > c) b += 1;
  return b;
}

function buildConditions(labelled: LabelledReading[], ofiCuts: Record<number, number[]>): Condition[] {
  const conditions: Condition[] = [
    { name: 'bias LONG', direction: 1, test: (l) => l.r.bias?.bias === 'LONG' },
    { name: 'bias SHORT', direction: -1, test: (l) => l.r.bias?.bias === 'SHORT' },
    { name: 'bias LONG onset', direction: 1, test: (l) => l.biasOnset && l.r.bias?.bias === 'LONG' },
    { name: 'bias SHORT onset', direction: -1, test: (l) => l.biasOnset && l.r.bias?.bias === 'SHORT' },
    { name: 'bias NEUTRAL', direction: 0, test: (l) => l.r.bias?.bias === 'NEUTRAL' },
    { name: 'evidence SUPPORTS_LONG', direction: 1, test: (l) => l.r.evidence === 'SUPPORTS_LONG' },
    { name: 'evidence SUPPORTS_SHORT', direction: -1, test: (l) => l.r.evidence === 'SUPPORTS_SHORT' },
  ];
  const windows = new Set<number>();
  for (const l of labelled) for (const w of l.r.windows ?? []) windows.add(w.ms);
  for (const ms of [...windows].sort((a, b) => a - b)) {
    for (const [phase, direction] of Object.entries(PHASE_DIRECTION)) {
      conditions.push({ name: `${windowLabel(ms)} ${phase}`, direction, test: (l) => l.r.windows?.find((w) => w.ms === ms)?.phase === phase });
    }
    const cuts = ofiCuts[ms];
    if (!cuts) continue;
    for (let q = 1; q <= 5; q += 1) {
      const direction: 1 | -1 | 0 = q === 5 ? 1 : q === 1 ? -1 : 0;
      conditions.push({
        name: `${windowLabel(ms)} OFI Q${q}`,
        direction,
        test: (l) => {
          const v = l.r.windows?.find((w) => w.ms === ms)?.ofi;
          return v !== null && v !== undefined && Number.isFinite(v) && ofiBucket(v, cuts) === q;
        },
      });
    }
  }
  return conditions;
}

// ---- evaluation --------------------------------------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function stats(rows: LabelledReading[], k: number, direction: 1 | -1, cfg: EvalConfig): CellStats {
  const net: Array<{ value: number; cluster: string }> = [];
  const gross: number[] = [];
  for (const l of rows) {
    const fwd = l.forwardBps[k];
    if (fwd === null || l.costBps === null) continue;
    gross.push(direction * fwd);
    net.push({ value: direction * fwd - l.costBps, cluster: l.cluster });
  }
  return { summary: bootstrapMean(net, { iterations: cfg.iterations, seed: cfg.seed, confidence: cfg.confidence }), grossMean: mean(gross) };
}

const enough = (s: CellStats, cfg: EvalConfig) => s.summary !== null && s.summary.n >= cfg.minN && s.summary.clusters >= cfg.minClusters;

/** Loads nothing itself: pass the readings per symbol (and malformed-line counts) already read from disk. */
export function evaluate(input: Array<{ symbol: string; readings: RecordedReading[]; malformed: number }>, cfg: EvalConfig = DEFAULT_EVAL_CONFIG): EvalResult {
  const integrity: IntegrityReport[] = [];
  const allSegments: RecordedReading[][] = [];
  for (const { symbol, readings, malformed } of input) {
    const { segments, integrity: rep } = segmentReadings(symbol, readings, malformed, cfg.gapMs);
    integrity.push(rep);
    allSegments.push(...segments);
  }
  // Segments are sorted, so their ends bound the range (no spread over a day's worth of readings: it overflows the stack)
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const seg of allSegments) {
    lo = Math.min(lo, seg[0].t);
    hi = Math.max(hi, seg[seg.length - 1].t);
  }
  const empty: EvalResult = { config: cfg, integrity, splitAt: null, labelled: 0, coverage: cfg.horizonsMs.map((h) => ({ horizonMs: h, labelled: 0 })), directional: [], baselines: [], costs: [], ofiQuintiles: {}, volThresholds: null };
  if (allSegments.length === 0) return empty;
  const splitAt = lo + (hi - lo) * (1 - cfg.holdoutFraction);

  const labelled = allSegments.flatMap((s) => labelSegment(s, cfg, splitAt));
  const train = labelled.filter((l) => l.split === 'train');

  // Thresholds come from training only, so the holdout is never used to define its own buckets.
  const trainVols = train.map((l) => l.vol).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const volThresholds: [number, number] | null = trainVols.length >= 30
    ? [trainVols[Math.floor(trainVols.length / 3)], trainVols[Math.floor((2 * trainVols.length) / 3)]]
    : null;
  for (const l of labelled) {
    l.regime = volThresholds && l.vol !== null ? (l.vol <= volThresholds[0] ? 'low' : l.vol <= volThresholds[1] ? 'mid' : 'high') : null;
  }
  const ofiQuintiles: Record<number, number[]> = {};
  const windowMs = new Set<number>();
  for (const l of train) for (const w of l.r.windows ?? []) windowMs.add(w.ms);
  for (const ms of windowMs) {
    const values = train.map((l) => l.r.windows?.find((w) => w.ms === ms)?.ofi).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length >= 50) ofiQuintiles[ms] = quintiles(values);
  }

  const conditions = buildConditions(labelled, ofiQuintiles);
  const directional: DirectionalCell[] = [];
  const baselines: BaselineCell[] = [];
  for (const c of conditions) {
    const rows = labelled.filter(c.test);
    cfg.horizonsMs.forEach((h, k) => {
      if (c.direction === 0) {
        const fwd = rows.map((l) => l.forwardBps[k]).filter((v): v is number => v !== null);
        baselines.push({ condition: c.name, horizonMs: h, n: fwd.length, meanBps: mean(fwd) });
        return;
      }
      const dir = c.direction;
      const hold = rows.filter((l) => l.split === 'holdout');
      directional.push({
        condition: c.name, direction: dir, horizonMs: h,
        train: stats(rows.filter((l) => l.split === 'train'), k, dir, cfg),
        holdout: stats(hold, k, dir, cfg),
        byRegime: {
          low: stats(hold.filter((l) => l.regime === 'low'), k, dir, cfg),
          mid: stats(hold.filter((l) => l.regime === 'mid'), k, dir, cfg),
          high: stats(hold.filter((l) => l.regime === 'high'), k, dir, cfg),
        },
        holmRejected: false,
        verdict: 'INSUFFICIENT',
      });
    });
  }

  // One family: every directional cell with enough data in both splits.
  const tested = directional.filter((d) => enough(d.train, cfg) && enough(d.holdout, cfg));
  const rejected = holm(tested.map((d) => d.holdout.summary!.pValue), cfg.alpha);
  tested.forEach((d, i) => {
    d.holmRejected = rejected[i];
    d.verdict = d.train.summary!.ciLow > 0 && d.holdout.summary!.ciLow > 0 && rejected[i] ? 'PASS' : 'FAIL';
  });

  const costs: CostProfile[] = [];
  const byStatus = new Map<string, number[]>();
  for (const l of labelled) {
    if (l.costBps === null) continue;
    const status = l.r.friction?.status ?? 'unrecorded';
    const bucket = byStatus.get(status);
    if (bucket) bucket.push(l.costBps);
    else byStatus.set(status, [l.costBps]);
  }
  for (const [status, values] of [...byStatus].sort()) {
    const s = values.sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
    costs.push({ status, n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99) });
  }

  return {
    config: cfg,
    integrity,
    splitAt,
    labelled: labelled.length,
    coverage: cfg.horizonsMs.map((h, k) => ({ horizonMs: h, labelled: labelled.filter((l) => l.forwardBps[k] !== null).length })),
    directional,
    baselines,
    costs,
    ofiQuintiles,
    volThresholds,
  };
}

// ---- report ------------------------------------------------------------------------------------------------------

const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const iso = (t: number | null) => (t === null ? '—' : new Date(t).toISOString().replace('.000Z', 'Z'));
const cell = (s: CellStats) => (s.summary ? `${s.summary.n} / ${s.summary.clusters} | ${f(s.grossMean)} | ${f(s.summary.mean)} [${f(s.summary.ciLow)}, ${f(s.summary.ciHigh)}]` : '0 | — | —');

export function renderReport(res: EvalResult): string {
  const c = res.config;
  const lines: string[] = [];
  lines.push('# Microstructure evaluation', '');
  lines.push(`Horizons ${c.horizonsMs.map(windowLabel).join(', ')} · fee ${c.feeBps} bps/side · holdout last ${(c.holdoutFraction * 100).toFixed(0)}% (from ${iso(res.splitAt)}) · clusters ${windowLabel(c.blockMs)} blocks per symbol · ${(c.confidence * 100).toFixed(0)}% CI · ${c.iterations} resamples, seed ${c.seed}${c.strideMs ? ` · stride ${windowLabel(c.strideMs)}` : ''}`, '');

  lines.push('## Recording integrity', '');
  lines.push('| Symbol | Lines | Malformed | Duplicates | Out of order | Live | Statuses | Live segments | Gaps > ' + windowLabel(c.gapMs) + ' | Longest gap | From | To |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |');
  for (const i of res.integrity) {
    const st = Object.entries(i.statuses).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`| ${i.symbol} | ${i.lines} | ${i.malformed} | ${i.duplicates} | ${i.outOfOrder} | ${pct(i.live, i.lines - i.malformed - i.duplicates)} | ${st} | ${i.segments} | ${i.gaps} | ${i.longestGapMs ? `${(i.longestGapMs / 1000).toFixed(0)}s` : '—'} | ${iso(i.firstT)} | ${iso(i.lastT)} |`);
  }
  lines.push('', `Only LIVE readings inside contiguous live segments are labelled; a gap or a non-live book ends a segment, so no label spans one.`, '');

  lines.push('## Label coverage', '', '| Horizon | Labelled readings |', '| --- | ---: |');
  for (const cv of res.coverage) lines.push(`| ${windowLabel(cv.horizonMs)} | ${cv.labelled} of ${res.labelled} |`);
  lines.push('');

  lines.push('## Directional conditions (net of costs, bps)', '');
  lines.push('Value per reading: direction × forward mid move − round-trip cost. Directions are fixed in code. Each cell is `n / clusters | gross mean | net mean [CI]`. PASS needs train CI > 0, holdout CI > 0 and Holm-corrected holdout significance across all tested cells.', '');
  lines.push('| Condition | Dir | Horizon | Train | Holdout | Holdout p | Verdict |');
  lines.push('| --- | :---: | --- | --- | --- | ---: | --- |');
  const order = { PASS: 0, FAIL: 1, INSUFFICIENT: 2 } as const;
  for (const d of [...res.directional].sort((a, b) => order[a.verdict] - order[b.verdict] || a.condition.localeCompare(b.condition) || a.horizonMs - b.horizonMs)) {
    lines.push(`| ${d.condition} | ${d.direction > 0 ? 'long' : 'short'} | ${windowLabel(d.horizonMs)} | ${cell(d.train)} | ${cell(d.holdout)} | ${f(d.holdout.summary?.pValue, 4)} | ${d.verdict}${d.holmRejected ? ' (Holm)' : ''} |`);
  }
  lines.push('');

  const passes = res.directional.filter((d) => d.verdict === 'PASS');
  lines.push('## Holdout by volatility regime', '');
  if (!res.volThresholds) lines.push('Not enough training data to set regime thresholds.', '');
  else {
    lines.push(`Realized-vol terciles from training: low ≤ ${f(res.volThresholds[0], 3)}, mid ≤ ${f(res.volThresholds[1], 3)} bps/√s, high above. Shown for PASS cells${passes.length ? '' : ' (none passed; the best five holdout means are shown instead)'}.`, '');
    const shown = passes.length ? passes : [...res.directional].filter((d) => d.holdout.summary).sort((a, b) => b.holdout.summary!.mean - a.holdout.summary!.mean).slice(0, 5);
    lines.push('| Condition | Horizon | Low | Mid | High |', '| --- | --- | --- | --- | --- |');
    for (const d of shown) lines.push(`| ${d.condition} | ${windowLabel(d.horizonMs)} | ${cell(d.byRegime.low)} | ${cell(d.byRegime.mid)} | ${cell(d.byRegime.high)} |`);
    lines.push('');
  }

  lines.push('## Baselines (undirected, before costs)', '', 'Mean forward mid move for conditions with no fixed direction; a sanity check on drift, not a test.', '');
  lines.push(`| Condition | ${c.horizonsMs.map(windowLabel).join(' | ')} |`, `| --- | ${c.horizonsMs.map(() => '---:').join(' | ')} |`);
  const names = [...new Set(res.baselines.map((b) => b.condition))];
  for (const name of names) lines.push(`| ${name} | ${c.horizonsMs.map((h) => { const b = res.baselines.find((x) => x.condition === name && x.horizonMs === h)!; return `${f(b.meanBps)} (${b.n})`; }).join(' | ')} |`);
  lines.push('');

  lines.push('## Round-trip cost by friction status (bps)', '', '| Status | n | p50 | p90 | p99 |', '| --- | ---: | ---: | ---: | ---: |');
  for (const k of res.costs) lines.push(`| ${k.status} | ${k.n} | ${f(k.p50)} | ${f(k.p90)} | ${f(k.p99)} |`);
  lines.push('', 'Compare these with MICRO_MAX_SPREAD_BPS / MICRO_MAX_SLIP_BPS before tuning the entry gate.', '');

  lines.push('## Caveats', '');
  lines.push('- Forward moves are mid to mid; costs are the recorded slippage for MICRO_ORDER_NOTIONAL, not your fills.');
  lines.push('- Readings within a cluster block overlap; the cluster bootstrap accounts for that, `--stride` removes it.');
  lines.push('- A PASS is a candidate for a pre-registered forward test, not a trading rule. Re-running with changed thresholds on the same holdout spends it.');
  return lines.join('\n');
}
