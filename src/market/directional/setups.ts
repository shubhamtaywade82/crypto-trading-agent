import type { Side } from '../../types.js';
import { barKnownAt, type FlowBar, type RejectionEvent, type ZoneDirection } from '../rejection/types.js';
import type { BarrierSetup } from './barriers.js';
import type { ContextSeries } from './context.js';

/**
 * Turns CONFIRMED rejections into barrier setups. Each setup enters at the confirming bar's close, which is when the
 * rejection became known. Its stop is the sweep extreme pushed `stopBufferAtr` ATR beyond it, on the far side from
 * entry. Its tag is the expansion context at entry, so every context gets its own calibration cell.
 *
 * A rejection whose stop would not lie beyond the entry close is skipped and not labelled. Skips are counted so the
 * caller can see how many candidates were dropped.
 */

export interface SetupOptions {
  side: Side;
  /** Distance past the sweep extreme, in ATR at the sweep bar. Starting value 0.1; tune only through an experiment. */
  stopBufferAtr: number;
}

export interface SetupBuild {
  setups: BarrierSetup[];
  skippedNotBeyondEntry: number;
  skippedNoEntryBar: number;
}

export function setupsFromRejections(
  bars: readonly FlowBar[],
  events: readonly RejectionEvent[],
  context: ContextSeries,
  opts: SetupOptions,
): SetupBuild {
  if (!(Number.isFinite(opts.stopBufferAtr) && opts.stopBufferAtr >= 0)) throw new Error('stopBufferAtr must be >= 0');
  if (context.side !== opts.side) throw new Error(`context is for ${context.side}, setups requested for ${opts.side}`);
  const direction: ZoneDirection = opts.side === 'LONG' ? 'DEMAND' : 'SUPPLY';
  const sign = opts.side === 'LONG' ? 1 : -1;

  const indexByKnownAt = new Map<number, number>();
  bars.forEach((b, i) => {
    if (b.complete) indexByKnownAt.set(barKnownAt(b), i);
  });

  const setups: BarrierSetup[] = [];
  let skippedNotBeyondEntry = 0;
  let skippedNoEntryBar = 0;
  for (const e of events) {
    if (e.status !== 'CONFIRMED' || e.direction !== direction || e.resolvedAt === null) continue;
    const entryIndex = indexByKnownAt.get(e.resolvedAt);
    const entryBar = entryIndex === undefined ? undefined : bars[entryIndex];
    if (entryIndex === undefined || !entryBar) {
      skippedNoEntryBar += 1;
      continue;
    }
    const stopPrice = e.extreme - sign * opts.stopBufferAtr * e.atr;
    if (!(sign * (entryBar.close - stopPrice) > 0)) {
      skippedNotBeyondEntry += 1;
      continue;
    }
    setups.push({
      id: e.id,
      symbol: e.symbol,
      side: opts.side,
      entryIndex,
      stopPrice,
      tags: [context.states[entryIndex] ?? 'NONE'],
    });
  }

  return { setups, skippedNotBeyondEntry, skippedNoEntryBar };
}
