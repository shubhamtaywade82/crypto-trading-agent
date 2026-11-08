import { utcDay } from '../../research/Bootstrap.js';
import type { Side } from '../../types.js';
import { TIMEFRAME_MS, barKnownAt, type FlowBar } from '../rejection/types.js';

/**
 * Triple-barrier labelling for percent targets. For each setup, horizon and target this records the first barrier
 * touched: the target, the stop, or the time limit. It also records the excursions and the net return after costs.
 *
 * Conventions, aligned with `playbooks/outcome.ts`:
 * - The entry fills at the entry bar's close, which is its known-at time. Only bars after the entry are read.
 * - Within a bar, the stop is tested before the target. A bar that touches both is a STOP.
 * - A stop gap fills at the bar's open when that is worse than the stop. A target fills at the target price.
 * - TIMEOUT exits at the close of bar entryIndex + horizonBars.
 * - A missing or incomplete bar before resolution makes the label UNRESOLVED, not a loss.
 *
 * Costs are required input. The module has no default venue fee, slippage or funding rate.
 */

export interface CostModel {
  /** Taker fee per side, in bps of notional. */
  feeBpsPerSide: number;
  /** Expected adverse slippage per side, in bps. */
  slippageBpsPerSide: number;
  /** Expected funding a LONG pays per hour, in bps. Negative means a LONG receives it. */
  fundingBpsPerHour: number;
}

export function assertCostModel(c: CostModel): void {
  if (!(Number.isFinite(c.feeBpsPerSide) && c.feeBpsPerSide >= 0)) throw new Error(`feeBpsPerSide must be >= 0, got ${c.feeBpsPerSide}`);
  if (!(Number.isFinite(c.slippageBpsPerSide) && c.slippageBpsPerSide >= 0)) {
    throw new Error(`slippageBpsPerSide must be >= 0, got ${c.slippageBpsPerSide}`);
  }
  if (!Number.isFinite(c.fundingBpsPerHour)) throw new Error(`fundingBpsPerHour must be finite, got ${c.fundingBpsPerHour}`);
}

/**
 * Round-trip cost in percent of entry notional for a position held `holdHours`.
 * Fees and slippage are paid on both legs. A LONG pays funding when it is positive, and a SHORT receives it.
 */
export function roundTripCostPct(costs: CostModel, side: Side, holdHours: number): number {
  const sign = side === 'LONG' ? 1 : -1;
  return (2 * (costs.feeBpsPerSide + costs.slippageBpsPerSide)) / 100 + (sign * costs.fundingBpsPerHour * holdHours) / 100;
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
  /** Price return at exit, in percent of entry, signed for the side. Null when UNRESOLVED. */
  grossReturnPct: number | null;
  /** grossReturnPct minus the round-trip cost for the holding period. Null when UNRESOLVED. */
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

  const resolved = outcome !== 'UNRESOLVED';
  const holdHours = outcome === 'TIMEOUT' || !resolved || barsToOutcome === null
    ? p.horizonHours
    : (barsToOutcome * tfMs) / 3_600_000;
  const grossReturnPct = resolved ? (sign * (exitPrice - entryPrice) / entryPrice) * 100 : null;
  const netReturnPct = grossReturnPct === null ? null : grossReturnPct - roundTripCostPct(costs, setup.side, holdHours);

  return {
    setupId: setup.id,
    symbol: setup.symbol,
    side: setup.side,
    tags: setup.tags,
    entryTime: p.entryTime,
    horizonEndsAt: p.entryTime + p.horizonHours * 3_600_000,
    day: utcDay(p.entryTime),
    entryPrice,
    stopPct: p.stopPct,
    targetPct: p.targetPct,
    horizonHours: p.horizonHours,
    outcome: outcome ?? 'UNRESOLVED',
    unresolvedReason,
    barsToOutcome,
    mfePct: mfe,
    maePct: mae,
    grossReturnPct,
    netReturnPct,
  };
}
