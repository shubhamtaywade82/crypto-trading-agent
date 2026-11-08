import { bootstrapMean, quantileSorted, utcDay, type BootstrapSummary } from '../../research/Bootstrap.js';
import { computeFeatures } from '../rejection/features.js';
import { TIMEFRAME_MS, barKnownAt, type FlowBar } from '../rejection/types.js';
import {
  assertCostModel, assertFundingCoverage, feeSlippageRoundTripPct,
  type BarrierSetup, type CostModel,
} from './barriers.js';

/**
 * Paired replay of exit policies on identical entries. Every policy receives the same setups, the same initial stop
 * and therefore the same initial risk R. Results are reported in R multiples, so the comparison is size-independent.
 *
 * Bar convention (matches the barrier labeller):
 * - Funding is charged for each settlement inside (previous bar's known-at, this bar's known-at], on the fraction still
 *   open at the start of the bar. This is an approximation within the settlement bar.
 * - Within a bar the stop is tested before any target or rung. A bar that touches both does not book the rung.
 * - A stop gap fills at the open when that is worse. Targets and rungs fill at their price.
 * - Trailing ratchets only after the first rung books, and only from the bar after its extremes are known.
 *   The trailing rule here is deliberately simple. It is a research control, not the trailing engine's policy.
 * - Fees: the entry leg and each exit leg pay fee plus slippage on their notional.
 *
 * A trade that hits a data gap before it resolves is UNRESOLVED and is excluded from every summary.
 */

export type TrailRule =
  | { kind: 'CHANDELIER'; atrPeriod: number; multiple: number }
  | { kind: 'FIXED_PCT'; pct: number };

export type ExitPolicy =
  | { kind: 'SINGLE_TARGET'; targetPct: number }
  | {
    kind: 'LADDER_RUNNER';
    rungs: readonly { targetPct: number; fraction: number }[];
    trail: TrailRule;
    /** Move the stop to entry plus round-trip fee and slippage once the first rung books. */
    breakEvenAfterFirstRung: boolean;
  };

export interface ReplayOptions {
  /** Maximum bars a trade may stay open, counting from the bar after entry. */
  maxBars: number;
  costs: CostModel;
}

export interface ExitPiece {
  price: number;
  /** Fraction of the original position, 0..1. */
  fraction: number;
  reason: 'TARGET' | 'RUNG' | 'BREAKEVEN' | 'TRAIL' | 'STOP' | 'TIMEOUT';
  barIndex: number;
}

export interface TradeReplay {
  setupId: string;
  side: BarrierSetup['side'];
  day: string;
  entryTime: number;
  entryPrice: number;
  /** Initial risk in percent of entry. Identical across policies for the same setup. */
  riskPct: number;
  resolved: boolean;
  unresolvedReason: 'DATA_ENDED' | 'GAP_BEFORE_RESOLUTION' | null;
  exits: ExitPiece[];
  grossPct: number;
  feePct: number;
  /** Funding paid (positive) or received (negative), percent of entry. */
  fundingPct: number;
  netPct: number;
  rMultiple: number;
  barsHeld: number;
  fundingModel: 'SETTLEMENTS' | 'CONSTANT_FALLBACK';
}

const EPS = 1e-12;

export function replayTrade(
  bars: readonly FlowBar[],
  setup: BarrierSetup,
  policy: ExitPolicy,
  opts: ReplayOptions,
  atrByBar: readonly (number | null)[],
): TradeReplay {
  assertCostModel(opts.costs);
  const entry = bars[setup.entryIndex];
  if (!entry || !entry.complete) throw new Error(`${setup.id}: entry bar is missing or incomplete`);
  const tfMs = TIMEFRAME_MS[entry.timeframe];
  const sign = setup.side === 'LONG' ? 1 : -1;
  const entryPrice = entry.close;
  const riskPct = (sign * (entryPrice - setup.stopPrice) / entryPrice) * 100;
  if (!(riskPct > 0)) throw new Error(`${setup.id}: stop ${setup.stopPrice} is not beyond entry ${entryPrice}`);
  const entryKnown = barKnownAt(entry);
  const legPct = (opts.costs.feeBpsPerSide + opts.costs.slippageBpsPerSide) / 100;
  const fundingModel = opts.costs.funding.kind;
  if (opts.costs.funding.kind === 'SETTLEMENTS') {
    assertFundingCoverage(opts.costs.funding.settlements, entryKnown, entryKnown + opts.maxBars * tfMs);
  }

  const ladder = policy.kind === 'LADDER_RUNNER' ? policy : null;
  const rungs = ladder ? [...ladder.rungs].sort((a, b) => a.targetPct - b.targetPct) : [];
  const singleTarget = policy.kind === 'SINGLE_TARGET' ? entryPrice * (1 + (sign * policy.targetPct) / 100) : null;
  const breakEvenPrice = entryPrice * (1 + (sign * feeSlippageRoundTripPct(opts.costs)) / 100);

  const exits: ExitPiece[] = [];
  let stop = setup.stopPrice;
  let stopReason: 'STOP' | 'BREAKEVEN' | 'TRAIL' = 'STOP';
  let open = 1;
  let favourable = entryPrice;
  let rungIdx = 0;
  let fundingPct = 0;
  let prevKnown = entryKnown;
  let unresolvedReason: TradeReplay['unresolvedReason'] = null;
  let barsHeld = 0;

  for (let j = setup.entryIndex + 1; j <= setup.entryIndex + opts.maxBars && open > EPS; j++) {
    const bar = bars[j];
    const prev = bars[j - 1];
    if (!bar || !prev) {
      unresolvedReason = 'DATA_ENDED';
      break;
    }
    if (!bar.complete || bar.openTime - prev.openTime !== tfMs) {
      unresolvedReason = 'GAP_BEFORE_RESOLUTION';
      break;
    }
    barsHeld = j - setup.entryIndex;
    const known = barKnownAt(bar);

    if (opts.costs.funding.kind === 'SETTLEMENTS') {
      for (const s of opts.costs.funding.settlements) {
        if (s.time > prevKnown && s.time <= known) fundingPct += sign * s.rate * (s.markPrice / entryPrice) * open * 100;
      }
    } else {
      fundingPct += (sign * opts.costs.funding.fundingBpsPerHour * (tfMs / 3_600_000) * open) / 100;
    }
    prevKnown = known;

    const stopHit = sign > 0 ? bar.low <= stop : bar.high >= stop;
    if (stopHit) {
      const price = sign > 0 ? Math.min(stop, bar.open) : Math.max(stop, bar.open);
      exits.push({ price, fraction: open, reason: stopReason, barIndex: j });
      open = 0;
      break;
    }

    if (singleTarget !== null) {
      const hit = sign > 0 ? bar.high >= singleTarget : bar.low <= singleTarget;
      if (hit) {
        exits.push({ price: singleTarget, fraction: open, reason: 'TARGET', barIndex: j });
        open = 0;
        break;
      }
    } else if (ladder) {
      while (rungIdx < rungs.length) {
        const rung = rungs[rungIdx];
        if (!rung) break;
        const price = entryPrice * (1 + (sign * rung.targetPct) / 100);
        const hit = sign > 0 ? bar.high >= price : bar.low <= price;
        if (!hit) break;
        exits.push({ price, fraction: rung.fraction, reason: 'RUNG', barIndex: j });
        open -= rung.fraction;
        rungIdx += 1;
        if (rungIdx === 1 && ladder.breakEvenAfterFirstRung && sign * (breakEvenPrice - stop) > 0) {
          stop = breakEvenPrice;
          stopReason = 'BREAKEVEN';
        }
      }
      if (open <= EPS) break;

      if (rungIdx >= 1) {
        favourable = sign > 0 ? Math.max(favourable, bar.high) : Math.min(favourable, bar.low);
        const candidate = trailCandidate(ladder.trail, favourable, sign, atrByBar[j - 1] ?? null);
        if (candidate !== null && sign * (candidate - stop) > 0) {
          stop = candidate;
          stopReason = 'TRAIL';
        }
      }
    }

    if (j === setup.entryIndex + opts.maxBars && open > EPS) {
      exits.push({ price: bar.close, fraction: open, reason: 'TIMEOUT', barIndex: j });
      open = 0;
    }
  }

  const resolved = unresolvedReason === null && open <= EPS;
  const grossPct = exits.reduce((acc, e) => acc + e.fraction * ((sign * (e.price - entryPrice)) / entryPrice) * 100, 0);
  const exitedFraction = exits.reduce((acc, e) => acc + e.fraction, 0);
  const feePct = legPct * (1 + (resolved ? exitedFraction : 0));
  const netPct = resolved ? grossPct - feePct - fundingPct : Number.NaN;

  return {
    setupId: setup.id,
    side: setup.side,
    day: utcDay(entryKnown),
    entryTime: entryKnown,
    entryPrice,
    riskPct,
    resolved,
    unresolvedReason,
    exits,
    grossPct: resolved ? grossPct : Number.NaN,
    feePct: resolved ? feePct : Number.NaN,
    fundingPct: resolved ? fundingPct : Number.NaN,
    netPct,
    rMultiple: resolved ? netPct / riskPct : Number.NaN,
    barsHeld,
    fundingModel,
  };
}

function trailCandidate(trail: TrailRule, favourable: number, sign: number, atr: number | null): number | null {
  if (trail.kind === 'FIXED_PCT') return favourable * (1 - (sign * trail.pct) / 100);
  if (atr === null || !(atr > 0)) return null;
  return favourable - sign * trail.multiple * atr;
}

/** Replays one policy over every setup. `atrPeriod` for the chandelier is taken from the policy itself. */
export function replayPolicy(
  bars: readonly FlowBar[],
  setups: readonly BarrierSetup[],
  policy: ExitPolicy,
  opts: ReplayOptions,
): TradeReplay[] {
  if (policy.kind === 'LADDER_RUNNER') {
    const booked = policy.rungs.reduce((acc, r) => acc + r.fraction, 0);
    if (!(booked > 0 && booked < 1)) throw new Error(`ladder rungs book ${booked}; a runner must remain`);
  }
  const atrPeriod = policy.kind === 'LADDER_RUNNER' && policy.trail.kind === 'CHANDELIER' ? policy.trail.atrPeriod : 14;
  const atrByBar = computeFeatures(bars, { atrPeriod, volumeWindow: 20, minVolumeHistory: 10 }).map((f) => f?.atr ?? null);
  return setups.map((s) => replayTrade(bars, s, policy, opts, atrByBar));
}

export interface ReplaySummary {
  n: number;
  unresolved: number;
  meanR: number | null;
  medianR: number | null;
  winRate: number | null;
  /** Sum of positive R over sum of absolute negative R. Null when there are no losses. */
  profitFactor: number | null;
  /** Largest peak-to-trough fall of cumulative R, in entry-time order. */
  maxDrawdownR: number;
  worstR: number | null;
  p05R: number | null;
  meanBarsHeld: number | null;
  /** Mean bars held as a share of the replay horizon. */
  exposure: number | null;
  meanNetPct: number | null;
  fundingModels: string[];
}

export function summarizeReplays(trades: readonly TradeReplay[], maxBars: number): ReplaySummary {
  const resolved = trades.filter((t) => t.resolved).sort((a, b) => a.entryTime - b.entryTime);
  const unresolved = trades.length - resolved.length;
  const rs = resolved.map((t) => t.rMultiple);
  const n = rs.length;
  if (n === 0) {
    return { n, unresolved, meanR: null, medianR: null, winRate: null, profitFactor: null, maxDrawdownR: 0, worstR: null,
      p05R: null, meanBarsHeld: null, exposure: null, meanNetPct: null, fundingModels: [] };
  }
  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const sorted = [...rs].sort((a, b) => a - b);
  let cum = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDrawdownR = Math.max(maxDrawdownR, peak - cum);
  }
  const gains = sum(rs.filter((r) => r > 0));
  const losses = -sum(rs.filter((r) => r < 0));
  const meanBars = sum(resolved.map((t) => t.barsHeld)) / n;
  return {
    n,
    unresolved,
    meanR: sum(rs) / n,
    medianR: quantileSorted(sorted, 0.5),
    winRate: rs.filter((r) => r > 0).length / n,
    profitFactor: losses > 0 ? gains / losses : null,
    maxDrawdownR,
    worstR: sorted[0] ?? null,
    p05R: quantileSorted(sorted, 0.05),
    meanBarsHeld: meanBars,
    exposure: maxBars > 0 ? meanBars / maxBars : null,
    meanNetPct: sum(resolved.map((t) => t.netPct)) / n,
    fundingModels: [...new Set(resolved.map((t) => t.fundingModel))].sort(),
  };
}

export interface PairedDifference {
  /** Setups resolved under both policies. */
  n: number;
  /** Mean of (B − A) in R multiples. */
  meanDiffR: number | null;
  /** Day-clustered bootstrap of the mean difference. */
  interval: BootstrapSummary | null;
}

/** Paired comparison of policy B against policy A on setups both resolve. Clusters are UTC entry days. */
export function pairedDifference(
  a: readonly TradeReplay[],
  b: readonly TradeReplay[],
  bootstrap: { iterations: number; seed: number; confidence: number },
): PairedDifference {
  const byId = new Map(a.filter((t) => t.resolved).map((t) => [t.setupId, t]));
  const diffs: { value: number; cluster: string }[] = [];
  for (const tb of b) {
    if (!tb.resolved) continue;
    const ta = byId.get(tb.setupId);
    if (!ta) continue;
    diffs.push({ value: tb.rMultiple - ta.rMultiple, cluster: tb.day });
  }
  if (diffs.length === 0) return { n: 0, meanDiffR: null, interval: null };
  const mean = diffs.reduce((acc, d) => acc + d.value, 0) / diffs.length;
  return { n: diffs.length, meanDiffR: mean, interval: bootstrapMean(diffs, bootstrap) };
}
