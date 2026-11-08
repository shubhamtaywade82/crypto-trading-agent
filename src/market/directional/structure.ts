/**
 * Swing pivots in directional coordinates. A pivot at bar i needs bars i−k … i+k, so it is only known at bar i+k.
 * Callers pass series already multiplied by s = ±1 (LONG: price; SHORT: −price), so "high" always means the favourable
 * extreme for the side. A window containing an invalid bar (incomplete or non-contiguous) produces no pivot.
 */

export interface Pivot {
  /** Bar index of the pivot. */
  index: number;
  /** Bar index at which the pivot became known (index + k). Use only for t >= confirmedAt. */
  confirmedAt: number;
  /** Directional price of the pivot. */
  price: number;
}

export interface Pivots {
  /** Favourable-extreme pivots, in index order. */
  highs: Pivot[];
  /** Adverse-extreme pivots, in index order. */
  lows: Pivot[];
}

export function confirmedPivots(
  xHigh: readonly number[],
  xLow: readonly number[],
  valid: readonly boolean[],
  k: number,
): Pivots {
  if (!Number.isInteger(k) || k < 1) throw new Error(`swing k must be an integer >= 1, got ${k}`);
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  for (let i = k; i + k < xHigh.length; i++) {
    let windowValid = true;
    for (let j = i - k; j <= i + k; j++) {
      if (valid[j] !== true) {
        windowValid = false;
        break;
      }
    }
    if (!windowValid) continue;

    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const hi = xHigh[i] as number;
      const lo = xLow[i] as number;
      if (j < i) {
        // Strictly above every earlier high and below every earlier low: the first bar of a plateau is the pivot.
        if (!(hi > (xHigh[j] as number))) isHigh = false;
        if (!(lo < (xLow[j] as number))) isLow = false;
      } else {
        if (!(hi >= (xHigh[j] as number))) isHigh = false;
        if (!(lo <= (xLow[j] as number))) isLow = false;
      }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, confirmedAt: i + k, price: xHigh[i] as number });
    if (isLow) lows.push({ index: i, confirmedAt: i + k, price: xLow[i] as number });
  }

  return { highs, lows };
}
