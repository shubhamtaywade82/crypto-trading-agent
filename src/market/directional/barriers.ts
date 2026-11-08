import { utcDay } from '../../research/Bootstrap.js';
import type { Side } from '../../types.js';
import { TIMEFRAME_MS, barKnownAt, type FlowBar } from '../rejection/types.js';

/**
 * Triple-barrier labelling for percent targets. For each setup, horizon and target this records the first barrier
 * touched: the target, the stop, or the time limit. It also records the excursions and the net return after costs.
 *
 * Conventions, aligned with `playbooks/outcome.ts`:
 * - The entry fills at the entry bar's close, which is its known-at time. Only that close and later bars are read.
 * - Within a bar, the stop is tested before the target. A bar that touches both is a STOP.
 * - A stop gap fills at the bar's open when that is worse than the stop. A target fills at the target price.
 * - TIMEOUT exits at the close of bar entryIndex + horizonBars.
 * - A missing or incomplete bar before resolution makes the label UNRESOLVED, not a loss.
 *
 * Funding is settlement-accurate when the caller supplies settlements. Each settlement a position is open through is
 * charged at rate × mark / entry. The constant-rate model is a research fallback, and every label records which
 * model produced its funding term.
 */

/** One funding settlement from `perp_funding_history` (funding_time, funding_rate, mark_price). */
export interface FundingSettlement {
  /** Settlement time, ms UTC. */
  time: number;
  /** Rate applied at this settlement, as a fraction. 0.0001 is 1 bp. */
  rate: number;
  /** Mark price at settlement. Funding notional is position size × mark. */
  markPrice: number;
}

export type FundingModel =
  | { kind: 'SETTLEMENTS'; settlements: readonly FundingSettlement[] }
  /** Research fallback only. Charges a constant hourly rate, and is labelled as such everywhere it is used. */
  | { kind: 'CONSTANT_FALLBACK'; fundingBpsPerHour: number };

export interface CostModel {
  /** Taker fee per side, in bps of notional. */
  feeBpsPerSide: number;
  /** Expected adverse slippage per side, in bps. */
  slippageBpsPerSide: number;
  funding: FundingModel;
}

/** Largest gap allowed between consecutive settlements (8 h plus a minute of tolerance). */
export const MAX_SETTLEMENT_GAP_MS = 8 * 3_600_000 + 60_000;

export function assertCostModel(c: CostModel): void {
  if (!(Number.isFinite(c.feeBpsPerSide) && c.feeBpsPerSide >= 0)) throw new Error(`feeBpsPerSide must be >= 0, got ${c.feeBpsPerSide}`);
  if (!(Number.isFinite(c.slippageBpsPerSide) && c.slippageBpsPerSide >= 0)) {
    throw new Error(`slippageBpsPerSide must be >= 0, got ${c.slippageBpsPerSide}`);
  }
  if (c.funding.kind === 'CONSTANT_FALLBACK') {
    if (!Number.isFinite(c.funding.fundingBpsPerHour)) throw new Error('fundingBpsPerHour must be finite');
    return;
  }
  let prev = Number.NEGATIVE_INFINITY;
  for (const s of c.funding.settlements) {
    if (!(Number.isFinite(s.time) && s.time > prev)) throw new Error(`settlements must be finite and strictly ascending at ${s.time}`);
    if (!(Number.isFinite(s.rate) && Math.abs(s.rate) < 0.1)) throw new Error(`settlement rate ${s.rate} is not a plausible fraction`);
    if (!(Number.isFinite(s.markPrice) && s.markPrice > 0)) throw new Error(`settlement mark ${s.markPrice} must be positive`);
    prev = s.time;
  }
}

/**
 * Requires the settlement list to cover [from, to] without a gap larger than one funding interval. A silent gap would
 * understate funding, so coverage is checked before any label is produced.
 */
export function assertFundingCoverage(settlements: readonly FundingSettlement[], from: number, to: number): void {
  const inWindow = settlements.filter((s) => s.time >= from - MAX_SETTLEMENT_GAP_MS && s.time <= to + MAX_SETTLEMENT_GAP_MS);
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!first || first.time - from > MAX_SETTLEMENT_GAP_MS) throw new Error('FUNDING_COVERAGE: no settlement near the start of the window');
  if (!last || to - last.time > MAX_SETTLEMENT_GAP_MS) throw new Error('FUNDING_COVERAGE: no settlement near the end of the window');
  for (let i = 1; i < inWindow.length; i++) {
    const gap = (inWindow[i] as FundingSettlement).time - (inWindow[i - 1] as FundingSettlement).time;
    if (gap > MAX_SETTLEMENT_GAP_MS) throw new Error(`FUNDING_COVERAGE: ${Math.round(gap / 60_000)} min gap between settlements`);
  }
}

/** A row of `perp_funding_history` as the pg driver returns it. Numeric columns may arrive as strings. */
export interface PerpFundingRow {
  funding_time: number | string;
  funding_rate: number | string;
  mark_price: number | string;
}

/**
 * Converts stored funding rows into settlements. Rows are sorted and exact duplicates collapse. Two different rows at
 * the same time are refused, because either one would silently change the funding cost of every position that spans it.
 */
export function fundingSettlementsFromRows(rows: readonly PerpFundingRow[]): FundingSettlement[] {
  const byTime = new Map<number, FundingSettlement>();
  for (const r of rows) {
    const s: FundingSettlement = { time: Number(r.funding_time), rate: Number(r.funding_rate), markPrice: Number(r.mark_price) };
    if (!(Number.isFinite(s.time) && Number.isFinite(s.rate) && Number.isFinite(s.markPrice) && s.markPrice > 0)) {
      throw new Error(`invalid funding row at ${String(r.funding_time)}`);
    }
    const prior = byTime.get(s.time);
    if (prior && (prior.rate !== s.rate || prior.markPrice !== s.markPrice)) {
      throw new Error(`conflicting funding rows at ${s.time}`);
    }
    byTime.set(s.time, s);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Fee and slippage only, round trip, percent of entry notional. Funding is priced separately. */
export function feeSlippageRoundTripPct(costs: Pick<CostModel, 'feeBpsPerSide' | 'slippageBpsPerSide'>): number {
  return (2 * (costs.feeBpsPerSide + costs.slippageBpsPerSide)) / 100;
}

/**
 * Funding paid over a position held from entryTime to exitTime, percent of entry notional. Positive means paid.
 * A LONG pays a positive rate and a SHORT receives it. A settlement counts when entryTime < time <= exitTime.
 */
export function fundingCostPct(side: Side, entryTime: number, exitTime: number, entryPrice: number, funding: FundingModel): number {
  const sign = side === 'LONG' ? 1 : -1;
  if (funding.kind === 'CONSTANT_FALLBACK') {
    return (sign * funding.fundingBpsPerHour * ((exitTime - entryTime) / 3_600_000)) / 100;
  }
  let sum = 0;
  for (const s of funding.settlements) {
    if (s.time > entryTime && s.time <= exitTime) sum += sign * s.rate * (s.markPrice / entryPrice);
  }
  return sum * 100;
}

export interface BarrierSetup {
  id: string;
  symbol: string;
  side: Side;
  /** Index of the entry bar in the series. The entry fills at its close. */
  entryIndex: number;
  /** Structural invalidation: below entry for a LONG, above entry for a SHORT. */
  stopPrice: number;
  /** Context labels at entry. Each tag becomes its own calibration cell. */
  tags: readonly string[];
}

export interface BarrierSpec {
  /** Target distances in percent of entry, for example [1, 2, 3, 5, 10]. */
  targetsPct: readonly number[];
  /** Horizons in hours. Each must be a whole number of bars of the series' timeframe. */
  horizonsHours: readonly number[];
}

export type BarrierOutcome = 'TARGET' | 'STOP' | 'TIMEOUT' | 'UNRESOLVED';

export interface BarrierLabel {
  setupId: string;
  symbol: string;
  side: Side;
  tags: readonly string[];
  /** Known-at time of the entry bar. */
  entryTime: number;
  /** The label is final only after this time. Used to purge training labels that run into the holdout. */
  horizonEndsAt: number;
  /** UTC day of entry. The cluster unit for bootstrap intervals. */
  day: string;
  entryPrice: number;
  /** Stop distance in percent of entry (positive). */
  stopPct: number;
  targetPct: number;
  horizonHours: number;
  outcome: BarrierOutcome;
  unresolvedReason: 'DATA_ENDED' | 'GAP_BEFORE_RESOLUTION' | null;
  /** Bars after entry at which the outcome occurred. Null when UNRESOLVED. */
  barsToOutcome: number | null;
  /** Largest favourable and adverse excursion in percent of entry, up to resolution or the horizon. */
  mfePct: number;
  maePct: number;
  /** Price return at exit, percent of entry, signed for the side. Null when UNRESOLVED. */
  grossReturnPct: number | null;
  /** Fee and slippage, round trip, percent of entry. Null when UNRESOLVED. */
  feeSlippagePct: number | null;
  /** Funding paid (positive) or received (negative), percent of entry. Null when UNRESOLVED. */
  fundingPct: number | null;
  fundingModel: FundingModel['kind'];
  /** grossReturnPct − feeSlippagePct − fundingPct. Null when UNRESOLVED. */
  netReturnPct: number | null;
}

function validateSpec(spec: BarrierSpec): void {
  if (spec.targetsPct.length === 0 || spec.targetsPct.some((t) => !(Number.isFinite(t) && t > 0))) {
    throw new Error('targetsPct must be a non-empty list of positive percentages');
  }
  if (spec.horizonsHours.length === 0 || spec.horizonsHours.some((h) => !(Number.isFinite(h) && h > 0))) {
    throw new Error('horizonsHours must be a non-empty list of positive hours');
  }
}

export function labelBarriers(
  bars: readonly FlowBar[],
  setups: readonly BarrierSetup[],
  spec: BarrierSpec,
  costs: CostModel,
): BarrierLabel[] {
  assertCostModel(costs);
  validateSpec(spec);
  const maxHorizonHours = Math.max(...spec.horizonsHours);
  const out: BarrierLabel[] = [];

  for (const setup of setups) {
    const entry = bars[setup.entryIndex];
    if (!entry || !entry.complete) throw new Error(`${setup.id}: entry bar is missing or incomplete`);
    const tfMs = TIMEFRAME_MS[entry.timeframe];
    const sign = setup.side === 'LONG' ? 1 : -1;
    const entryPrice = entry.close;
    const stopPct = (sign * (entryPrice - setup.stopPrice) / entryPrice) * 100;
    if (!(stopPct > 0)) throw new Error(`${setup.id}: stop ${setup.stopPrice} is not beyond entry ${entryPrice} for ${setup.side}`);
    const entryTime = barKnownAt(entry);

    if (costs.funding.kind === 'SETTLEMENTS') {
      assertFundingCoverage(costs.funding.settlements, entryTime, entryTime + maxHorizonHours * 3_600_000);
    }

    for (const horizonHours of spec.horizonsHours) {
      const horizonBars = (horizonHours * 3_600_000) / tfMs;
      if (!Number.isInteger(horizonBars) || horizonBars < 1) {
        throw new Error(`${setup.id}: horizon ${horizonHours}h is not a whole number of ${entry.timeframe} bars`);
      }
      for (const targetPct of spec.targetsPct) {
        out.push(labelOne({
          bars, setup, entryIndex: setup.entryIndex, entryPrice, entryTime, sign, stopPct,
          targetPct, horizonHours, horizonBars, tfMs, costs,
        }));
      }
    }
  }
  return out;
}

interface LabelInput {
  bars: readonly FlowBar[];
  setup: BarrierSetup;
  entryIndex: number;
  entryPrice: number;
  entryTime: number;
  sign: 1 | -1;
  stopPct: number;
  targetPct: number;
  horizonHours: number;
  horizonBars: number;
  tfMs: number;
  costs: CostModel;
}

function labelOne(p: LabelInput): BarrierLabel {
  const { bars, setup, entryIndex, entryPrice, sign, horizonBars, tfMs, costs } = p;
  const targetPrice = entryPrice * (1 + (sign * p.targetPct) / 100);
  let mfe = 0;
  let mae = 0;
  let outcome: BarrierOutcome | null = null;
  let unresolvedReason: BarrierLabel['unresolvedReason'] = null;
  let barsToOutcome: number | null = null;
  let exitPrice = Number.NaN;

  for (let j = entryIndex + 1; j <= entryIndex + horizonBars; j++) {
    const bar = bars[j];
    const prev = bars[j - 1];
    if (!bar || !prev) {
      outcome = 'UNRESOLVED';
      unresolvedReason = 'DATA_ENDED';
      break;
    }
    if (!bar.complete || bar.openTime - prev.openTime !== tfMs) {
      outcome = 'UNRESOLVED';
      unresolvedReason = 'GAP_BEFORE_RESOLUTION';
      break;
    }
    const favourable = sign > 0 ? bar.high - entryPrice : entryPrice - bar.low;
    const adverse = sign > 0 ? entryPrice - bar.low : bar.high - entryPrice;
    mfe = Math.max(mfe, (favourable / entryPrice) * 100);
    mae = Math.max(mae, (adverse / entryPrice) * 100);

    const stopHit = sign > 0 ? bar.low <= setup.stopPrice : bar.high >= setup.stopPrice;
    const targetHit = sign > 0 ? bar.high >= targetPrice : bar.low <= targetPrice;
    if (stopHit) {
      outcome = 'STOP';
      barsToOutcome = j - entryIndex;
      exitPrice = sign > 0 ? Math.min(setup.stopPrice, bar.open) : Math.max(setup.stopPrice, bar.open);
      break;
    }
    if (targetHit) {
      outcome = 'TARGET';
      barsToOutcome = j - entryIndex;
      exitPrice = targetPrice;
      break;
    }
  }

  if (outcome === null) {
    const exitBar = bars[entryIndex + horizonBars];
    if (!exitBar) {
      outcome = 'UNRESOLVED';
      unresolvedReason = 'DATA_ENDED';
    } else {
      outcome = 'TIMEOUT';
      barsToOutcome = horizonBars;
      exitPrice = exitBar.close;
    }
  }

  if (outcome === 'UNRESOLVED' || barsToOutcome === null) {
    return baseLabel(p, outcome, unresolvedReason, null, mfe, mae, null, null, null, null);
  }
  const exitTime = p.entryTime + barsToOutcome * tfMs;
  const grossReturnPct = (sign * (exitPrice - entryPrice) / entryPrice) * 100;
  const feeSlippagePct = feeSlippageRoundTripPct(costs);
  const fundingPct = fundingCostPct(setup.side, p.entryTime, exitTime, entryPrice, costs.funding);
  const netReturnPct = grossReturnPct - feeSlippagePct - fundingPct;
  return baseLabel(p, outcome, null, barsToOutcome, mfe, mae, grossReturnPct, feeSlippagePct, fundingPct, netReturnPct);
}

function baseLabel(
  p: LabelInput,
  outcome: BarrierOutcome,
  unresolvedReason: BarrierLabel['unresolvedReason'],
  barsToOutcome: number | null,
  mfePct: number,
  maePct: number,
  grossReturnPct: number | null,
  feeSlippagePct: number | null,
  fundingPct: number | null,
  netReturnPct: number | null,
): BarrierLabel {
  return {
    setupId: p.setup.id,
    symbol: p.setup.symbol,
    side: p.setup.side,
    tags: p.setup.tags,
    entryTime: p.entryTime,
    horizonEndsAt: p.entryTime + p.horizonHours * 3_600_000,
    day: utcDay(p.entryTime),
    entryPrice: p.entryPrice,
    stopPct: p.stopPct,
    targetPct: p.targetPct,
    horizonHours: p.horizonHours,
    outcome,
    unresolvedReason,
    barsToOutcome,
    mfePct,
    maePct,
    grossReturnPct,
    feeSlippagePct,
    fundingPct,
    fundingModel: p.costs.funding.kind,
    netReturnPct,
  };
}
