import type { Candle } from '../types.js';
import { atrSeries } from '../strategies/smc-ml/math.js';
import type { SMCFrame, StructureBreak } from '../strategies/smc-ml/types.js';
import { closeTimeOf } from './context.js';
import type { EntryZone, PlaybookContext, PlaybookDefinition, SetupFacts, TradeDirection } from './types.js';

/**
 * Facts each playbook derives before any rule runs. Derivation never judges: it locates the break, zone, stop, arming
 * event, trigger and target, leaving null whatever it cannot establish, and the rules decide whether that is acceptable.
 *
 * Outcome fields of the SMC analysis (retestOutcome, followThroughOutcome) are never read here: they resolve with
 * candles after the break and would leak the future into the decision.
 */

export const dirOf = (direction: TradeDirection): 1 | -1 => (direction === 'LONG' ? 1 : -1);

/** ATR14 of `candles` at the bar that opened at `openTime`, using the same ATR the SMC engine uses. */
export function atrAt(candles: readonly Candle[], openTime: number): number | null {
  const index = candles.findIndex((c) => c.openTime === openTime);
  if (index < 0) return null;
  const value = atrSeries([...candles])[index];
  return value === null || value === undefined || !(value > 0) ? null : value;
}

/** Nearest untaken liquidity beyond `reference` in the trade direction: zone frame first, then the bias frames in order. */
function nearestTarget(ctx: PlaybookContext, frames: readonly SMCFrame[], dir: 1 | -1, reference: number): number | null {
  for (const frame of frames) {
    const pools = ctx.frames[frame]?.liquidityPools ?? [];
    const beyond = pools.filter((p) => p.direction === dir && (p.price - reference) * dir > 0).map((p) => p.price);
    if (beyond.length > 0) return dir === 1 ? Math.min(...beyond) : Math.max(...beyond);
  }
  return null;
}

/** First trigger-frame break in the trade direction whose candle opened at or after the arming close. */
function firstTrigger(ctx: PlaybookContext, frame: SMCFrame, dir: 1 | -1, armedAt: number): StructureBreak | null {
  const breaks = (ctx.frames[frame]?.breaks ?? []).filter((b) => b.direction === dir && b.time >= armedAt);
  return breaks.sort((a, b) => a.time - b.time)[0] ?? null;
}

/** First trigger-frame candle that opened at or after `from` and satisfies `test`. */
function firstCandle(ctx: PlaybookContext, frame: SMCFrame, from: number, test: (c: Candle) => boolean): Candle | null {
  return (ctx.candles[frame] ?? []).find((c) => c.openTime >= from && test(c)) ?? null;
}

type ArmingRule = (
  ctx: PlaybookContext,
  pb: PlaybookDefinition,
  base: SetupFacts & { zoneBreak: StructureBreak; breakClosedAt: number; zoneAtr: number },
) => { zone: EntryZone | null; stop: number | null; armedAt: number | null };

const protectedStop = (b: StructureBreak, dir: 1 | -1, buffer: number): number => b.protectedSwing - dir * buffer;

/** Sweep reversal: the zone is the FVG left by the displacement leg; the setup arms when the break candle closes. */
const sweepReversal: ArmingRule = (ctx, pb, f) => {
  const b = f.zoneBreak;
  const fvg = (ctx.frames[pb.frames.zone]?.fairValueGaps ?? [])
    .filter((g) => g.direction === f.dir && g.index >= b.protectedSwingIndex && g.index <= b.index)
    .sort((x, y) => y.index - x.index)[0];
  return {
    zone: fvg ? { kind: 'FVG', top: fvg.top, bottom: fvg.bottom } : null,
    stop: protectedStop(b, f.dir, pb.params.stopBufferAtr * f.zoneAtr),
    armedAt: f.breakClosedAt,
  };
};

/** Continuation: the FVG of the displacement leg, else the order block of the break; arms when price trades back into it. */
const continuation: ArmingRule = (ctx, pb, f) => {
  const b = f.zoneBreak;
  const frame = ctx.frames[pb.frames.zone];
  const fvg = (frame?.fairValueGaps ?? [])
    .filter((g) => g.direction === f.dir && g.index >= b.protectedSwingIndex && g.index <= b.index)
    .sort((x, y) => y.index - x.index)[0];
  // orderBlockForBreak searches up to 3 bars before the protected swing
  const ob = (frame?.orderBlocks ?? [])
    .filter((o) => o.direction === f.dir && o.index >= b.protectedSwingIndex - 3 && o.index <= b.protectedSwingIndex)
    .sort((x, y) => y.index - x.index)[0];
  const zone: EntryZone | null = fvg
    ? { kind: 'FVG', top: fvg.top, bottom: fvg.bottom }
    : ob ? { kind: 'ORDER_BLOCK', top: ob.top, bottom: ob.bottom } : null;
  const touch = zone === null ? null : firstCandle(ctx, pb.frames.trigger, f.breakClosedAt, (c) => (f.dir === 1 ? c.low <= zone.top : c.high >= zone.bottom));
  return {
    zone,
    stop: protectedStop(b, f.dir, pb.params.stopBufferAtr * f.zoneAtr),
    armedAt: touch ? closeTimeOf(pb.frames.trigger, touch.openTime) : null,
  };
};

/** Breakout and retest: the zone is a band around the broken level; arms on a trigger-frame retest that closes back beyond it. */
const breakoutRetest: ArmingRule = (ctx, pb, f) => {
  const b = f.zoneBreak;
  const tol = (pb.params.levelToleranceAtr ?? 0) * f.zoneAtr;
  const zone: EntryZone = { kind: 'LEVEL', top: b.level + tol, bottom: b.level - tol };
  const retest = firstCandle(ctx, pb.frames.trigger, f.breakClosedAt, (c) => (f.dir === 1
    ? c.low <= zone.top && c.close > b.level
    : c.high >= zone.bottom && c.close < b.level));
  const buffer = pb.params.stopBufferAtr * f.zoneAtr;
  const farEdge = f.dir === 1 ? zone.bottom : zone.top;
  const extreme = retest === null ? farEdge : f.dir === 1 ? Math.min(retest.low, farEdge) : Math.max(retest.high, farEdge);
  return {
    zone,
    stop: extreme - f.dir * buffer,
    armedAt: retest ? closeTimeOf(pb.frames.trigger, retest.openTime) : null,
  };
};

const ARMING: Readonly<Record<PlaybookDefinition['id'], ArmingRule>> = {
  sweep_mss_fvg_reversal: sweepReversal,
  bos_fvg_ob_continuation: continuation,
  breakout_retest: breakoutRetest,
};

export function deriveFacts(ctx: PlaybookContext, pb: PlaybookDefinition, direction: TradeDirection): SetupFacts {
  const dir = dirOf(direction);
  const zoneFrame = ctx.frames[pb.frames.zone];
  const zoneCandles = ctx.candles[pb.frames.zone] ?? [];
  const zoneAtr = zoneFrame?.atr14 !== null && zoneFrame?.atr14 !== undefined && zoneFrame.atr14 > 0 ? zoneFrame.atr14 : null;
  const zoneBreak = zoneFrame?.latestBreak ?? null;
  const breakClosedAt = zoneBreak ? closeTimeOf(pb.frames.zone, zoneBreak.time) : null;
  const facts: SetupFacts = {
    direction, dir, zoneAtr, zoneBreak, breakClosedAt,
    breakCandle: zoneBreak ? zoneCandles.find((c) => c.openTime === zoneBreak.time) ?? null : null,
    breakAtr: zoneBreak ? atrAt(zoneCandles, zoneBreak.time) : null,
    zone: null, stop: null, armedAt: null, trigger: null, triggerClosedAt: null, target: null, plan: null,
  };
  // Everything past the break belongs to a break in this direction; an opposite break leaves the setup empty
  if (!zoneBreak || zoneBreak.direction !== dir || breakClosedAt === null || zoneAtr === null) return facts;

  const armed = ARMING[pb.id](ctx, pb, { ...facts, zoneBreak, breakClosedAt, zoneAtr });
  facts.zone = armed.zone;
  facts.stop = armed.stop;
  facts.armedAt = armed.armedAt;
  if (armed.armedAt !== null) {
    facts.trigger = firstTrigger(ctx, pb.frames.trigger, dir, armed.armedAt);
    facts.triggerClosedAt = facts.trigger ? closeTimeOf(pb.frames.trigger, facts.trigger.time) : null;
  }
  const reference = facts.trigger?.breakClose ?? zoneFrame?.lastPrice ?? null;
  const targetFrames = [pb.frames.zone, ...pb.frames.bias];
  facts.target = reference === null ? null : nearestTarget(ctx, targetFrames, dir, reference);
  // Registry v3: after the trigger confirms, the entry is a limit at the zone's near edge, not the trigger close. A trigger
  // usually closes away from the zone, and entering at that close was a chase on every triggered setup in replay
  if (facts.trigger && facts.zone && facts.stop !== null && facts.target !== null) {
    facts.plan = { entry: dir === 1 ? facts.zone.top : facts.zone.bottom, stop: facts.stop, target: facts.target };
  }
  return facts;
}
