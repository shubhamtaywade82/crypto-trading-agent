import type { SMCFrame } from '../strategies/smc-ml/types.js';
import { closeTimeOf, FRAME_MS } from './context.js';
import type { PlaybookContext, PlaybookDefinition, RuleEvaluation, RuleId, RuleStage, SetupFacts } from './types.js';

type RuleFn = (f: SetupFacts, ctx: PlaybookContext, pb: PlaybookDefinition) => Omit<RuleEvaluation, 'ruleId' | 'stage'>;

interface RuleDefinition {
  stage: RuleStage;
  evaluate: RuleFn;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const requiredFrames = (pb: PlaybookDefinition): SMCFrame[] => [...new Set<SMCFrame>([...pb.frames.bias, pb.frames.zone, pb.frames.trigger])];
const opposite = (direction: string): string => (direction === 'LONG' ? 'SHORT' : 'LONG');
const fail = (reason: string, extra: Partial<RuleEvaluation> = {}) => ({ passed: false, reason, ...extra });

/** The direction-matched zone-frame break, or the reason there is none. */
function breakInDirection(f: SetupFacts): string | null {
  if (!f.zoneBreak) return 'no zone-frame structure break';
  if (f.zoneBreak.direction !== f.dir) return `latest zone-frame break is ${f.zoneBreak.direction === 1 ? 'LONG' : 'SHORT'}`;
  return null;
}

/** Highest (LONG) or lowest (SHORT) zone-frame close since the break that would invalidate the setup, if any. */
function invalidatingClose(f: SetupFacts, ctx: PlaybookContext, pb: PlaybookDefinition, level: number) {
  const beyond = (close: number) => (close - level) * f.dir < 0;
  const after = f.zoneBreak!.time;
  const zoneHit = (ctx.candles[pb.frames.zone] ?? []).find((c) => c.openTime > after && beyond(c.close));
  if (zoneHit) return { frame: pb.frames.zone, close: zoneHit.close, at: closeTimeOf(pb.frames.zone, zoneHit.openTime) };
  const triggerHit = (ctx.candles[pb.frames.trigger] ?? []).find((c) => c.openTime >= f.breakClosedAt! && beyond(c.close));
  if (triggerHit) return { frame: pb.frames.trigger, close: triggerHit.close, at: closeTimeOf(pb.frames.trigger, triggerHit.openTime) };
  return null;
}

export const RULES: Readonly<Record<RuleId, RuleDefinition>> = {
  frames_present: {
    stage: 'CONTEXT',
    evaluate: (_f, ctx, pb) => {
      const missing = requiredFrames(pb).filter((frame) => !ctx.frames[frame]);
      if (missing.length === 0) return { passed: true, reason: `all of ${requiredFrames(pb).join(', ')} analysed`, observedValue: requiredFrames(pb).join(',') };
      const issues = missing.map((frame) => `${frame}: ${ctx.dataIssues[frame] ?? 'no candles'}`).join('; ');
      return fail(`missing frames (${issues})`, { observedValue: missing.join(',') });
    },
  },
  data_fresh: {
    stage: 'CONTEXT',
    evaluate: (_f, ctx, pb) => {
      let worst = 0;
      let worstFrame = '';
      for (const frame of requiredFrames(pb)) {
        const last = ctx.candles[frame]?.at(-1);
        if (!last) continue;
        const lagBars = (ctx.now - closeTimeOf(frame, last.openTime)) / FRAME_MS[frame];
        if (lagBars >= worst) { worst = lagBars; worstFrame = frame; }
      }
      const passed = worst < pb.params.maxStaleBars;
      return { passed, reason: passed ? 'every frame has its latest closed bar' : `${worstFrame} is ${round(worst, 2)} bars behind the clock`, observedValue: round(worst, 2), threshold: pb.params.maxStaleBars };
    },
  },
  htf_not_opposed: {
    stage: 'CONTEXT',
    evaluate: (f, ctx, pb) => {
      const trends = pb.frames.bias.map((frame) => `${frame}=${ctx.frames[frame]?.trend ?? 'MISSING'}`);
      const opposed = pb.frames.bias.filter((frame) => { const t = ctx.frames[frame]?.trend; return t === undefined || t === opposite(f.direction); });
      return { passed: opposed.length === 0, reason: opposed.length === 0 ? `no bias frame opposes ${f.direction}` : `${opposed.join(', ')} opposes ${f.direction} or is missing`, observedValue: trends.join(' '), threshold: `not ${opposite(f.direction)}` };
    },
  },
  htf_aligned: {
    stage: 'CONTEXT',
    evaluate: (f, ctx, pb) => {
      const trends = pb.frames.bias.map((frame) => `${frame}=${ctx.frames[frame]?.trend ?? 'MISSING'}`);
      const off = pb.frames.bias.filter((frame) => ctx.frames[frame]?.trend !== f.direction);
      return { passed: off.length === 0, reason: off.length === 0 ? `every bias frame trends ${f.direction}` : `${off.join(', ')} not trending ${f.direction}`, observedValue: trends.join(' '), threshold: f.direction };
    },
  },
  structure_break_in_direction: {
    stage: 'SETUP',
    evaluate: (f, _ctx, pb) => {
      const missing = breakInDirection(f);
      const required = pb.params.requiredBreakType;
      if (missing) return fail(missing, { observedValue: f.zoneBreak ? `${f.zoneBreak.type} ${f.zoneBreak.direction}` : null, threshold: `${required} ${f.direction}` });
      const type = f.zoneBreak!.type;
      const passed = required === 'ANY' || type === required;
      return { passed, reason: passed ? `${type} ${f.direction} on ${pb.frames.zone}` : `break is ${type}, playbook needs ${required}`, observedValue: type, threshold: required, evidenceTime: f.breakClosedAt ?? undefined };
    },
  },
  liquidity_swept_before_break: {
    stage: 'SETUP',
    evaluate: (f) => {
      const missing = breakInDirection(f);
      if (missing) return fail(missing);
      const swept = f.zoneBreak!.sweptLiquidityFirst;
      return { passed: swept, reason: swept ? 'the leg took the prior opposing swing before the break' : 'no liquidity was swept before the break', observedValue: swept, evidenceTime: f.breakClosedAt ?? undefined };
    },
  },
  displacement_confirmed: {
    stage: 'SETUP',
    evaluate: (f, _ctx, pb) => {
      const missing = breakInDirection(f);
      if (missing) return fail(missing, { threshold: pb.params.minDisplacementAtr });
      if (!f.breakCandle || f.breakAtr === null) return fail('break candle or its ATR unavailable', { threshold: pb.params.minDisplacementAtr });
      const body = (f.breakCandle.close - f.breakCandle.open) * f.dir;
      const displacement = body / f.breakAtr;
      const passed = displacement >= pb.params.minDisplacementAtr;
      return { passed, reason: passed ? 'break candle body clears the displacement threshold' : 'break candle body is below the displacement threshold', observedValue: round(displacement, 3), threshold: pb.params.minDisplacementAtr, evidenceTime: f.breakClosedAt ?? undefined };
    },
  },
  breakout_volume: {
    stage: 'SETUP',
    evaluate: (f, ctx, pb) => {
      const multiple = pb.params.minBreakoutVolumeMultiple;
      const lookback = pb.params.volumeLookback;
      if (multiple === undefined || lookback === undefined) return fail('playbook defines no volume threshold');
      const missing = breakInDirection(f);
      if (missing || !f.breakCandle) return fail(missing ?? 'break candle unavailable', { threshold: multiple });
      const candles = ctx.candles[pb.frames.zone] ?? [];
      const index = candles.findIndex((c) => c.openTime === f.breakCandle!.openTime);
      const prior = candles.slice(Math.max(0, index - lookback), index);
      const mean = prior.reduce((sum, c) => sum + c.volume, 0) / (prior.length || 1);
      if (prior.length < lookback || !(mean > 0)) return fail(`only ${prior.length} prior bars with volume, need ${lookback}`, { threshold: multiple });
      const ratio = f.breakCandle.volume / mean;
      const passed = ratio >= multiple;
      return { passed, reason: passed ? 'break volume clears the threshold' : 'break volume is below the threshold', observedValue: round(ratio, 3), threshold: multiple, evidenceTime: f.breakClosedAt ?? undefined };
    },
  },
  entry_zone_present: {
    stage: 'SETUP',
    evaluate: (f) => (f.zone
      ? { passed: true, reason: `${f.zone.kind} ${f.zone.bottom}-${f.zone.top}`, observedValue: f.zone.kind }
      : fail(breakInDirection(f) ?? 'no eligible FVG, order block or level for this break')),
  },
  zone_unmitigated: {
    stage: 'SETUP',
    evaluate: (f, ctx, pb) => {
      if (!f.zone || !f.zoneBreak) return fail('no entry zone');
      const farEdge = f.dir === 1 ? f.zone.bottom : f.zone.top;
      const hit = (ctx.candles[pb.frames.zone] ?? []).find((c) => c.openTime > f.zoneBreak!.time && (c.close - farEdge) * f.dir < 0);
      return hit
        ? fail(`a ${pb.frames.zone} bar closed through the zone`, { observedValue: hit.close, threshold: farEdge, evidenceTime: closeTimeOf(pb.frames.zone, hit.openTime) })
        : { passed: true, reason: 'no zone-frame close through the zone since the break', threshold: farEdge };
    },
  },
  structural_stop_defined: {
    stage: 'SETUP',
    evaluate: (f) => (f.stop !== null && Number.isFinite(f.stop)
      ? { passed: true, reason: 'stop beyond the structural extreme plus ATR buffer', observedValue: round(f.stop, 8) }
      : fail(breakInDirection(f) ?? 'no structural stop')),
  },
  setup_not_invalidated: {
    stage: 'SETUP',
    evaluate: (f, ctx, pb) => {
      if (f.stop === null || !f.zoneBreak || f.breakClosedAt === null) return fail(breakInDirection(f) ?? 'no structural stop to test against');
      // A breakout is also invalidated by acceptance back through the level band, not only by the stop
      const level = f.zone?.kind === 'LEVEL' ? (f.dir === 1 ? Math.max(f.stop, f.zone.bottom) : Math.min(f.stop, f.zone.top)) : f.stop;
      const hit = invalidatingClose(f, ctx, pb, level);
      return hit
        ? fail(`${hit.frame} closed at ${hit.close}, beyond the invalidation level`, { observedValue: hit.close, threshold: round(level, 8), evidenceTime: hit.at })
        : { passed: true, reason: 'no close beyond the invalidation level since the break', threshold: round(level, 8) };
    },
  },
  setup_fresh: {
    stage: 'SETUP',
    evaluate: (f, ctx, pb) => {
      if (f.breakClosedAt === null) return fail('no zone-frame break');
      const ageBars = (ctx.now - f.breakClosedAt) / FRAME_MS[pb.frames.zone];
      const passed = ageBars <= pb.params.maxSetupAgeBars;
      return { passed, reason: passed ? 'break is recent enough' : 'break is too old: setup expired', observedValue: round(ageBars, 2), threshold: pb.params.maxSetupAgeBars, evidenceTime: f.breakClosedAt };
    },
  },
  target_liquidity_available: {
    stage: 'SETUP',
    evaluate: (f) => (f.target !== null
      ? { passed: true, reason: 'untaken liquidity beyond the entry', observedValue: f.target }
      : fail(breakInDirection(f) ?? 'no untaken liquidity beyond the entry on the zone or bias frames')),
  },
  trigger_window_open: {
    stage: 'SETUP',
    evaluate: (f, ctx, pb) => {
      if (f.armedAt === null) return { passed: true, reason: 'not armed yet: the trigger window has not started' };
      const until = f.triggerClosedAt ?? ctx.now;
      const bars = (until - f.armedAt) / FRAME_MS[pb.frames.trigger];
      const passed = bars <= pb.params.maxTriggerBars;
      const what = f.triggerClosedAt === null ? 'bars since arming without a trigger' : 'bars from arming to trigger';
      return { passed, reason: passed ? `${what} within the window` : `${what} exceed the window: setup expired`, observedValue: round(bars, 2), threshold: pb.params.maxTriggerBars, evidenceTime: f.armedAt };
    },
  },
  armed: {
    stage: 'TRIGGER',
    evaluate: (f) => (f.armedAt !== null
      ? { passed: true, reason: 'arming event printed', evidenceTime: f.armedAt }
      : fail(breakInDirection(f) ?? 'waiting for the arming event (zone touch or retest)')),
  },
  trigger_confirmed: {
    stage: 'TRIGGER',
    evaluate: (f, _ctx, pb) => (f.trigger
      ? { passed: true, reason: `${pb.frames.trigger} ${f.trigger.type} closed at ${f.trigger.breakClose}`, observedValue: f.trigger.breakClose, evidenceTime: f.triggerClosedAt ?? undefined }
      : fail(`waiting for a closed ${pb.frames.trigger} break in the trade direction`)),
  },
  spread_within_limit: {
    stage: 'EXECUTION',
    evaluate: (_f, ctx, pb) => {
      const spread = ctx.execution.spreadBps;
      if (spread === null || !Number.isFinite(spread)) return fail('spread unknown', { observedValue: null, threshold: pb.params.maxSpreadBps });
      const passed = spread <= pb.params.maxSpreadBps;
      return { passed, reason: passed ? 'spread within limit' : 'spread too wide', observedValue: spread, threshold: pb.params.maxSpreadBps };
    },
  },
  stop_geometry_valid: {
    stage: 'EXECUTION',
    evaluate: (f, _ctx, pb) => {
      if (!f.plan || f.zoneAtr === null) return fail('no trade plan');
      const risk = (f.plan.entry - f.plan.stop) * f.dir;
      if (!(risk > 0)) return fail('stop is on the wrong side of the entry', { observedValue: f.plan.stop });
      const riskAtr = risk / f.zoneAtr;
      const passed = riskAtr >= pb.params.minStopAtr && riskAtr <= pb.params.maxStopAtr;
      return { passed, reason: passed ? 'stop distance within bounds' : 'stop distance out of bounds', observedValue: round(riskAtr, 3), threshold: `${pb.params.minStopAtr}-${pb.params.maxStopAtr} ATR` };
    },
  },
  entry_not_chased: {
    stage: 'EXECUTION',
    evaluate: (f, _ctx, pb) => {
      if (!f.plan || !f.zone || f.zoneAtr === null) return fail('no trade plan or zone');
      const nearEdge = f.dir === 1 ? f.zone.top : f.zone.bottom;
      const chaseAtr = ((f.plan.entry - nearEdge) * f.dir) / f.zoneAtr;
      const passed = chaseAtr <= pb.params.maxChaseAtr;
      return { passed, reason: passed ? 'entry close to the zone' : 'entry too far beyond the zone: chase', observedValue: round(chaseAtr, 3), threshold: pb.params.maxChaseAtr };
    },
  },
  entry_in_discount: {
    stage: 'EXECUTION',
    evaluate: (f, ctx, pb) => {
      const max = pb.params.maxLegPosition;
      if (max === undefined) return fail('playbook defines no leg-position threshold');
      if (!f.plan || !f.zoneBreak) return fail('no trade plan');
      const origin = f.zoneBreak.protectedSwing;
      const leg = (ctx.candles[pb.frames.zone] ?? []).filter((c) => c.openTime >= (ctx.candles[pb.frames.zone]?.[f.zoneBreak!.protectedSwingIndex]?.openTime ?? Infinity));
      if (leg.length === 0) return fail('displacement leg unavailable');
      const extreme = f.dir === 1 ? Math.max(...leg.map((c) => c.high)) : Math.min(...leg.map((c) => c.low));
      const span = (extreme - origin) * f.dir;
      if (!(span > 0)) return fail('displacement leg has no span');
      const position = ((f.plan.entry - origin) * f.dir) / span;
      const passed = position <= max;
      return { passed, reason: passed ? 'entry in the discount (LONG) / premium (SHORT) half of the leg' : 'entry in the wrong half of the leg', observedValue: round(position, 3), threshold: max };
    },
  },
  net_reward_risk_above_minimum: {
    stage: 'EXECUTION',
    evaluate: (f, ctx, pb) => {
      if (!f.plan) return fail('no trade plan');
      const cost = f.plan.entry * 2 * (ctx.execution.takerFeeRate + ctx.execution.slippageRate);
      const reward = (f.plan.target - f.plan.entry) * f.dir - cost;
      const risk = (f.plan.entry - f.plan.stop) * f.dir + cost;
      if (!(risk > 0)) return fail('risk is not positive');
      const rr = reward / risk;
      const passed = rr >= pb.params.minNetRewardRisk;
      return { passed, reason: passed ? 'net reward:risk after fees and slippage clears the minimum' : 'net reward:risk after fees and slippage is below the minimum', observedValue: round(rr, 3), threshold: pb.params.minNetRewardRisk };
    },
  },
  session_in_window: {
    stage: 'CONTEXT',
    evaluate: (f, ctx, pb) => {
      const windows = pb.params.sessionWindows;
      if (!windows || windows.length === 0) return fail('playbook defines no session windows');
      const minutes = utcMinutesOfDay(ctx.now);
      const hit = windows.find((w) => {
        const start = w.startHourUtc * 60 + (w.startMinuteUtc ?? 0);
        const end = w.endHourUtc * 60 + (w.endMinuteUtc ?? 0);
        return minutes >= start && minutes < end;
      });
      return hit
        ? { passed: true, reason: `trigger close is inside the ${hit.name} session`, observedValue: minutes, threshold: hit.name, evidenceTime: ctx.now }
        : { passed: false, reason: `trigger close is outside every session window (${windows.map((w) => w.name).join(', ')})`, observedValue: minutes, threshold: windows.map((w) => w.name).join(','), evidenceTime: ctx.now };
    },
  },
};

/** Minutes since UTC midnight; the session rule judges the trigger close (`ctx.now`) by time of day. */
export function utcMinutesOfDay(t: number): number {
  const d = new Date(t);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
