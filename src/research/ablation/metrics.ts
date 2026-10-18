import { FRAME_MS } from '../../playbooks/context.js';
import type { PlaybookDecisionRecord, PlaybookOutcomeRecord } from '../../playbooks/journal.js';
import { atrSeries } from '../../strategies/smc-ml/math.js';
import type { SMCFrame } from '../../strategies/smc-ml/types.js';
import type { Candle } from '../../types.js';
import { bootstrapMean, utcDay } from '../Bootstrap.js';
import type { ExperimentConfig, SplitStats, TradeRecord, VariantMetrics } from './types.js';

/**
 * Per-variant metrics over journal records. Every number is computed from the decision and outcome records the causal
 * replay wrote: nothing is re-derived from candles except the excursions (MAE/MFE), the cost share, and the volatility
 * regime of the decision time, which the journal does not store.
 */

export interface TradeInputs {
  decisions: readonly PlaybookDecisionRecord[];
  outcomeOf: (setupId: string) => PlaybookOutcomeRecord | null;
  triggerFrame: SMCFrame;
  /** Closed trigger-frame candles, for MAE/MFE. Null (and null excursions) when unavailable. */
  triggerCandles: readonly Candle[] | null;
  /** Closed zone-frame candles, for the volatility regime of the decision time. Null skips the regime split. */
  zoneCandles: readonly Candle[] | null;
  zoneFrame: SMCFrame;
  policy: ExperimentConfig['outcomePolicy'];
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const stdev = (xs: readonly number[]): number | null => {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const share = (k: number, n: number): number | null => (n === 0 ? null : k / n);

/** Zone-frame ATR14 as a fraction of price at the last zone bar that opened strictly before `t`. */
export function atrPctAt(zoneCandles: readonly Candle[], frame: SMCFrame, t: number): number | null {
  let index = -1;
  for (let i = zoneCandles.length - 1; i >= 0; i -= 1) {
    if (zoneCandles[i].openTime + FRAME_MS[frame] <= t) { index = i; break; }
  }
  if (index < 0) return null;
  const atr = atrSeries([...zoneCandles])[index];
  if (atr === null || atr === undefined || !(atr > 0)) return null;
  return atr / zoneCandles[index].close;
}

/** MAE/MFE of one filled trade in R units, scanned on the bars between the fill and the exit (inclusive). */
export function excursionR(direction: 'LONG' | 'SHORT', fill: number, entry: number, stop: number, bars: readonly Candle[]): { maeR: number | null; mfeR: number | null } {
  const dir = direction === 'LONG' ? 1 : -1;
  // Same unit as the outcome resolver: the fill's own risk, or the plan's when the fill was at or beyond the stop
  const fillRisk = (fill - stop) * dir;
  const planRisk = (entry - stop) * dir;
  const unit = fillRisk > 0 ? fillRisk : planRisk;
  if (!(unit > 0)) return { maeR: null, mfeR: null };
  let mae = 0;
  let mfe = 0;
  for (const bar of bars) {
    const adverse = dir === 1 ? (fill - bar.low) / unit : (bar.high - fill) / unit;
    const favourable = dir === 1 ? (bar.high - fill) / unit : (fill - bar.low) / unit;
    if (adverse > mae) mae = adverse;
    if (favourable > mfe) mfe = favourable;
  }
  return { maeR: mae, mfeR: mfe };
}

/** The risk unit an outcome was priced in: the fill's own risk, or the plan's when the fill sat at or beyond the stop. */
export const riskUnitR = (direction: 'LONG' | 'SHORT', fill: number, entry: number, stop: number): number => {
  const dir = direction === 'LONG' ? 1 : -1;
  const fillRisk = (fill - stop) * dir;
  return fillRisk > 0 ? fillRisk : (entry - stop) * dir;
};

export function tradesOf(inputs: TradeInputs): TradeRecord[] {
  const ms = FRAME_MS[inputs.triggerFrame];
  const costRate = inputs.policy.takerFeeRate + inputs.policy.slippageRate;
  const byOpen = inputs.triggerCandles ? new Map(inputs.triggerCandles.map((c) => [c.openTime, c])) : null;
  const out: TradeRecord[] = [];
  for (const d of inputs.decisions) {
    const o = inputs.outcomeOf(d.setupId);
    if (!o) continue;
    const hourUtc = new Date(d.decidedAt).getUTCHours();
    if (o.label === 'NOT_FILLED' || o.netR === null || o.fillPrice === null || o.exitPrice === null) {
      out.push({ setupId: d.setupId, direction: d.direction, decidedAt: d.decidedAt, filledAt: o.filledAt, resolvedAt: o.resolvedAt, label: o.label, netR: null, barsHeld: null, maeR: null, mfeR: null, costR: null, hourUtc });
      continue;
    }
    let maeR: number | null = null;
    let mfeR: number | null = null;
    if (byOpen && o.filledAt !== null && o.resolvedAt !== null) {
      const bars = [...byOpen.values()].filter((c) => c.openTime >= o.filledAt! && c.openTime + ms <= o.resolvedAt!);
      ({ maeR, mfeR } = excursionR(d.direction, o.fillPrice, d.plan.entry, d.plan.stop, bars));
    }
    const unit = riskUnitR(d.direction, o.fillPrice, d.plan.entry, d.plan.stop);
    const costR = unit > 0 ? ((o.fillPrice + o.exitPrice) * costRate) / unit : null;
    out.push({ setupId: d.setupId, direction: d.direction, decidedAt: d.decidedAt, filledAt: o.filledAt, resolvedAt: o.resolvedAt, label: o.label, netR: o.netR, barsHeld: o.barsHeld, maeR, mfeR, costR, hourUtc });
  }
  return out;
}

export function splitStats(trades: readonly TradeRecord[], keyOf: (t: TradeRecord) => string | null): Record<string, SplitStats> {
  const buckets = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const key = keyOf(t);
    if (key === null) continue;
    const list = buckets.get(key) ?? [];
    list.push(t);
    buckets.set(key, list);
  }
  const out: Record<string, SplitStats> = {};
  for (const key of [...buckets.keys()].sort()) {
    const filled = buckets.get(key)!.filter((t) => t.netR !== null);
    out[key] = { n: buckets.get(key)!.length, filled: filled.length, evR: mean(filled.map((t) => t.netR!)), winRate: share(filled.filter((t) => t.netR! > 0).length, filled.length) };
  }
  return out;
}

/** UTC session of the decision hour: asia 00-07, london 07-12, new_york 12-17, off_hours 17-24. */
export const sessionOf = (hourUtc: number): string =>
  hourUtc < 7 ? 'asia' : hourUtc < 12 ? 'london' : hourUtc < 17 ? 'new_york' : 'off_hours';

export function computeMetrics(
  trades: readonly TradeRecord[],
  cfg: ExperimentConfig,
  options: { bootstrapSeed: number; pending: number; triggerFrameMs: number; atrPctOf?: (t: TradeRecord) => number | null },
): VariantMetrics {
  const filled = trades.filter((t) => t.netR !== null);
  const rs = filled.map((t) => t.netR!);
  const wins = filled.filter((t) => t.netR! > 0);
  const losses = filled.filter((t) => t.netR! <= 0);
  const grossWin = wins.reduce((a, t) => a + t.netR!, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netR!, 0));
  const sortedByFill = [...filled].sort((a, b) => (a.filledAt ?? a.decidedAt) - (b.filledAt ?? b.decidedAt));
  let peak = 0;
  let cum = 0;
  let dd = 0;
  for (const t of sortedByFill) {
    cum += t.netR!;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  const boot = rs.length >= 2
    ? bootstrapMean(filled.map((t) => ({ value: t.netR!, cluster: utcDay(t.decidedAt) })), {
        confidence: 2 * cfg.bootstrap.confidence - 1,
        iterations: cfg.bootstrap.iterations,
        seed: options.bootstrapSeed,
      })
    : null;
  const atrPctOf = options.atrPctOf;
  let regimeSplit: Record<string, SplitStats> = {};
  if (atrPctOf) {
    const atrPcts = filled.map((t) => ({ t, atrPct: atrPctOf(t) })).filter((x): x is { t: TradeRecord; atrPct: number } => x.atrPct !== null);
    if (atrPcts.length >= 9) {
      const sorted = atrPcts.map((x) => x.atrPct).sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
      const [q33, q66] = [q(1 / 3), q(2 / 3)];
      const regimeKey = (p: number) => (p <= q33 ? 'calm' : p <= q66 ? 'normal' : 'volatile');
      regimeSplit = splitStats(filled, (t) => {
        const atrPct = atrPctOf(t);
        return atrPct === null ? null : regimeKey(atrPct);
      });
    }
  }
  const avgBars = mean(filled.map((t) => t.barsHeld).filter((x): x is number => x !== null));
  return {
    decisions: trades.length,
    filled: filled.length,
    notFilled: trades.length - filled.length,
    pending: options.pending,
    fillRate: share(filled.length, trades.length),
    evR: mean(rs),
    medianR: median(rs),
    stdevR: stdev(rs),
    winRate: share(wins.length, filled.length),
    targetRate: share(filled.filter((t) => t.label === 'TARGET').length, filled.length),
    stopRate: share(filled.filter((t) => t.label === 'STOP').length, filled.length),
    timeoutRate: share(filled.filter((t) => t.label === 'TIMEOUT').length, filled.length),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownR: filled.length > 0 ? dd : null,
    avgBarsHeld: avgBars,
    avgHoldMinutes: avgBars === null ? null : (avgBars * options.triggerFrameMs) / 60_000,
    avgMaeR: mean(filled.map((t) => t.maeR).filter((x): x is number => x !== null)),
    avgMfeR: mean(filled.map((t) => t.mfeR).filter((x): x is number => x !== null)),
    avgCostR: mean(filled.map((t) => t.costR).filter((x): x is number => x !== null)),
    bootstrap: boot,
    splits: {
      direction: splitStats(trades, (t) => t.direction),
      session: splitStats(trades, (t) => sessionOf(t.hourUtc)),
      regime: regimeSplit,
    },
  };
}
