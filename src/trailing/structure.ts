import type { Candle } from '../types.js';
import type { PolicyContext, StopCandidate, TrailingPolicy, TrailingState } from './types.js';
import { atrOf } from './price.js';

/**
 * Structure-trailing methods (spec §6 #7, #9). Pivots are closing-basis, strict (no ties), and
 * confirmed only nRight bars later — recomputation on any future slice can never alter a
 * confirmed pivot (no repainting; same confirmation contract as `src/market/SweepLedger.ts`).
 * BOS/CHoCH is one deterministic forward pass over confirmation+break events. The SHORT side
 * reuses the same pass on a price-negated series (high/low flipped), so the derivation exists
 * once and both directions map onto it; its trend=1/protected conventions are then uniform.
 */

export interface SwingPivot {
  index: number;
  price: number;
}

interface StructureResult {
  /** 1 = bullish structure in the passed series (BOS fired, no confirming CHoCH since); −1 bearish; 0 none. */
  trend: 1 | -1 | 0;
  /** Protected level in the series' own terms (bullish: protected higher low; bearish: protected lower high). */
  protected: number | null;
  breached: boolean;
  breachedLevel: number | null;
  /** Trend side that owned the breached protection (1 long / −1 short in the series' convention). */
  breachSide: 1 | -1 | 0;
}

function isExtremum(candles: Candle[], index: number, nLeft: number, nRight: number, high: boolean): boolean {
  const price = candles[index]?.close;
  if (price === undefined) return false;
  for (let j = index - nLeft; j <= index + nRight; j++) {
    if (j === index) continue;
    const other = candles[j]?.close;
    if (other === undefined) return false;
    if (high ? other >= price : other <= price) return false;
  }
  return true;
}

/** Confirmed closing-basis pivots only: a pivot at bar i joins iff bars up to i+nRight are closed. */
export function confirmedPivots(candles: Candle[], nLeft: number, nRight: number): { highs: SwingPivot[]; lows: SwingPivot[] } {
  const last = candles.length - 1;
  const highs: SwingPivot[] = [];
  const lows: SwingPivot[] = [];
  for (let i = nLeft; i <= last - nRight; i++) {
    const price = candles[i].close;
    if (isExtremum(candles, i, nLeft, nRight, true)) highs.push({ index: i, price });
    if (isExtremum(candles, i, nLeft, nRight, false)) lows.push({ index: i, price });
  }
  return { highs, lows };
}

// The protected pivot is the confirmed one whose index strictly precedes the broken pivot —
// deterministic "the low/high that led into the break", never a future pivot retrofitted.
function latestPreceding(list: SwingPivot[], brokenIndex: number): number | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].index < brokenIndex) return list[i].price;
  return null;
}

export function deriveStructure(candles: Candle[], nLeft: number, nRight: number): StructureResult {
  const out: StructureResult = { trend: 0, protected: null, breached: false, breachedLevel: null, breachSide: 0 };
  const last = candles.length - 1;
  if (last < nLeft + nRight) return out;
  const highSeq: SwingPivot[] = [];
  const lowSeq: SwingPivot[] = [];
  let brokenHighIdx = -1;
  let brokenLowIdx = -1;
  // Breach freshness: only a breach ON the last bar qualifies (each caller evaluates one pass),
  // so a historical CHoCH cannot re-fire an exit on a later pass that re-armed via a new BOS.
  // One close can be BOTH a CHoCH for the old side and a BOS that arms the other side: the BOS
  // stands (the flip is real), while the breach flag records the old side's exit only.
  let breachAt = -1;
  let breachLevel: number | null = null;
  let breachSide: 1 | -1 = 1;
  for (let t = 0; t <= last; t++) {
    const confirmIdx = t - nRight;
    if (confirmIdx >= nLeft) {
      if (isExtremum(candles, confirmIdx, nLeft, nRight, true)) highSeq.push({ index: confirmIdx, price: candles[confirmIdx].close });
      if (isExtremum(candles, confirmIdx, nLeft, nRight, false)) lowSeq.push({ index: confirmIdx, price: candles[confirmIdx].close });
    }
    const closeNow = candles[t].close;
    const prevTrend = out.trend;
    const prevProtected = out.protected;
    const high = highSeq.at(-1);
    const low = lowSeq.at(-1);
    // a confirmed pivot broken once is dead forever (`index > broken` guard), so no re-BOS spam
    const breaksHigh = high !== undefined && closeNow > high.price && high.index > brokenHighIdx;
    const breaksLow = !breaksHigh && low !== undefined && closeNow < low.price && low.index > brokenLowIdx;
    if (breaksHigh) {
      brokenHighIdx = high!.index;
      out.trend = 1;
      out.protected = latestPreceding(lowSeq, high!.index);
    } else if (breaksLow) {
      brokenLowIdx = low!.index;
      out.trend = -1;
      out.protected = latestPreceding(highSeq, low!.index);
    }
    const bosFired = breaksHigh || breaksLow;
    const breach = prevTrend === 1 && prevProtected !== null && closeNow < prevProtected
      ? prevProtected
      : prevTrend === -1 && prevProtected !== null && closeNow > prevProtected ? prevProtected : null;
    if (breach !== null) {
      breachAt = t;
      breachLevel = breach;
      // the breach condition required prevTrend = ±1, so the side is exactly that
      breachSide = prevTrend === 1 ? 1 : -1;
      if (!bosFired) {
        out.protected = null; // protection died with the price that crossed it; structure side stays
      }
    }
  }
  out.breached = breachAt === last;
  out.breachedLevel = out.breached ? breachLevel : null;
  out.breachSide = out.breached ? breachSide : 0;
  return out;
}

const mirrorCandle = (c: Candle): Candle => (
  { ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }
);

interface StructureParams {
  readonly nLeft: number;
  readonly nRight: number;
  readonly bufferAtr: number;
}

function structureStop(policy: TrailingPolicy, ctx: PolicyContext): StopCandidate | null {
  const params: StructureParams = {
    nLeft: policy.params.nLeft as number,
    nRight: policy.params.nRight as number,
    bufferAtr: policy.params.bufferAtr as number,
  };
  const series = ctx.s === 1 ? ctx.candles : ctx.candles.map(mirrorCandle);
  const st = deriveStructure(series, params.nLeft, params.nRight);
  // breach first: a CHoCH fires immediately even though a same-bar BOS may have flipped the trend.
  // breachSide guards relevance: the derivation always runs a long convention, so only a long-side
  // CHoCH is this policy's exit (for shorts, the mirror run maps real shorts onto that convention).
  if (st.breached && st.breachSide === 1) {
    return { policyId: policy.id, levelZ: st.breachedLevel ?? 0, priceReference: policy.priceReference, reason: `choch-break@${st.breachedLevel}`, exit: true };
  }
  if (st.trend !== 1 || st.protected === null) return null; // aligned structure + a protected level required
  const atr = atrOf(ctx.candles, 14);
  if (atr === null) return null; // refuse rather than protect without a cost-padded buffer reference
  const levelZ = st.protected - params.bufferAtr * atr;
  if (!(levelZ < ctx.s * ctx.price)) return null; // a stop the price has already crossed is not protection
  return { policyId: policy.id, levelZ, priceReference: policy.priceReference, reason: `bos@prot-${st.protected}` };
}

/** #9 BOS/CHoCH: stop under/over the protected level; CHoCH close emits an EXIT candidate. */
export const bosChoch = (policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState): StopCandidate | null => (
  structureStop(policy, ctx)
);

/** #7 Swing: trail from the latest confirmed pivot with max(ATR buffer, tick buffer). */
export const swingTrail = (policy: TrailingPolicy, ctx: PolicyContext, state: TrailingState): StopCandidate | null => {
  const atr = atrOf(ctx.candles, 14);
  if (atr === null) return null;
  const pivots = confirmedPivots(ctx.candles, policy.params.nLeft as number, policy.params.nRight as number);
  const pivot = ctx.s === 1 ? pivots.lows.at(-1) : pivots.highs.at(-1);
  if (!pivot) return null;
  const buffer = Math.max((policy.params.bufferAtr as number) * atr, (policy.params.bufferTicks as number) * (ctx.tickSize ?? 0));
  const stopPrice = ctx.s === 1 ? pivot.price - buffer : pivot.price + buffer;
  const levelZ = ctx.s * stopPrice;
  if (!(levelZ < ctx.s * ctx.price)) return null;
  return { policyId: policy.id, levelZ, priceReference: policy.priceReference, reason: `swing@${pivot.index}:${pivot.price}` };
};
