import type { Candle } from '../types.js';
import { analyzeSmcFrame } from '../strategies/smc-ml/SmcMlEngine.js';
import { DEFAULT_SMC_CONFIG, type SMCConfig, type SMCFrame, type SMCFrameAnalysis } from '../strategies/smc-ml/types.js';
import type { ExecutionSnapshot, PlaybookContext } from './types.js';

export const FRAME_MS: Readonly<Record<SMCFrame, number>> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/** Close time of a candle that opened at `openTime` on `frame`. */
export const closeTimeOf = (frame: SMCFrame, openTime: number): number => openTime + FRAME_MS[frame];

const validBar = (c: Candle): boolean =>
  [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) &&
  c.low > 0 && c.high >= c.low && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.volume >= 0;

/**
 * Keeps only bars that closed at or before `now`, sorted and unique by open time. Throws on an invalid bar or a gap: the
 * caller records it as a data issue, because a structure read across a gap is not the structure that traded.
 */
export function closedBars(frame: SMCFrame, candles: readonly Candle[], now: number): Candle[] {
  const byOpen = new Map<number, Candle>();
  for (const c of candles) {
    if (closeTimeOf(frame, c.openTime) > now) continue;
    if (!validBar(c)) throw new Error(`invalid ${frame} bar at ${c.openTime}`);
    const prior = byOpen.get(c.openTime);
    if (prior && (prior.close !== c.close || prior.high !== c.high || prior.low !== c.low)) {
      throw new Error(`conflicting duplicate ${frame} bar at ${c.openTime}`);
    }
    byOpen.set(c.openTime, c);
  }
  const bars = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].openTime - bars[i - 1].openTime !== FRAME_MS[frame]) {
      throw new Error(`gap in ${frame} bars between ${bars[i - 1].openTime} and ${bars[i].openTime}`);
    }
  }
  return bars;
}

/**
 * Builds the playbook context: the SMC-ML analysis is run here on exactly the candles the rules read, so FVG, order-block
 * and break indices always refer to the same array. A frame with bad data is left out and its problem recorded.
 */
export function buildPlaybookContext(
  symbol: string,
  now: number,
  rawCandles: Partial<Record<SMCFrame, readonly Candle[]>>,
  execution: ExecutionSnapshot,
  smcConfig: SMCConfig = DEFAULT_SMC_CONFIG,
): PlaybookContext {
  const candles: Partial<Record<SMCFrame, Candle[]>> = {};
  const frames: Partial<Record<SMCFrame, SMCFrameAnalysis>> = {};
  const dataIssues: Partial<Record<SMCFrame, string>> = {};
  for (const frame of Object.keys(rawCandles) as SMCFrame[]) {
    try {
      const bars = closedBars(frame, rawCandles[frame] ?? [], now);
      if (bars.length < smcConfig.swingLength * 2 + 1) throw new Error(`${bars.length} closed ${frame} bars, need ${smcConfig.swingLength * 2 + 1}`);
      frames[frame] = analyzeSmcFrame(frame, bars, smcConfig);
      candles[frame] = bars;
    } catch (err) {
      dataIssues[frame] = err instanceof Error ? err.message : String(err);
    }
  }
  return { symbol, now, candles, frames, dataIssues, execution, smcConfig };
}
