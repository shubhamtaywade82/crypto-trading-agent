import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { DEFAULT_SMC_CONFIG, type SMCFrame, type SMCFrameAnalysis, type StructureBreak } from '../src/strategies/smc-ml/types.js';
import {
  buildPlaybookContext, closedBars, evaluateAllPlaybooks, evaluatePlaybook, getPlaybook, listPlaybooks, validateRegistry,
  type PlaybookContext, type PlaybookDefinition, type PlaybookVerdict,
} from '../src/playbooks/index.js';

const M5 = 5 * 60_000;
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * 60 * 60_000;
const MS: Record<SMCFrame, number> = { '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': 24 * H1 };
/** A multiple of 4h, so every frame has a bar closing exactly now. */
const T = 118_056 * H4;
const EXECUTION = { spreadBps: 2, takerFeeRate: 0.0004, slippageRate: 0.0002 };

/** `count` flat bars (range 1) whose last one closes at `endClose`. */
function flat(frame: SMCFrame, count: number, endClose: number, price: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    openTime: endClose - (count - i) * MS[frame], open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 100,
  }));
}

function frame(timeframe: SMCFrame, over: Partial<SMCFrameAnalysis> = {}): SMCFrameAnalysis {
  return {
    timeframe, candleCount: 0, lastClosedTime: 0, lastPrice: 102, atr14: 1, volatilityStd: null, trend: 'NEUTRAL',
    dealingRangeHigh: null, dealingRangeLow: null, rangePositionPct: null, swings: [], breaks: [], latestBreak: null,
    orderBlocks: [], fairValueGaps: [], liquidityPools: [], nearestUpperLiquidity: null, nearestLowerLiquidity: null,
    liveLiquidityOdds: { upper: null, lower: null, formulaUpper: null, formulaLower: null },
    retestCalibration: { samples: 0, hitRate: null, brierModel: null, brierFormula: null, brierBase: null },
    liquidityCalibration: { samples: 0, hitRate: null, brierModel: null, brierFormula: null, brierBase: null },
    edgeTest: { totalResolved: 0, overallRate: null, splits: [] },
    ...over,
  };
}

function structureBreak(over: Partial<StructureBreak>): StructureBreak {
  return {
    direction: 1, type: 'BOS', index: 0, time: 0, level: 102, breakClose: 103, protectedSwing: 99, protectedSwingIndex: 34,
    riskUnit: 4, retestFormulaProbability: null, retestProbability: null, retestEntryPrice: null, retestOutcome: null,
    followThroughOutcome: null, sweptLiquidityFirst: false, leftFvg: false, nearestUpperPoolAtPrint: null, nearestLowerPoolAtPrint: null,
    ...over,
  };
}

/**
 * A LONG setup on 15m: the break candle (index 38) closes one bar before now, with a bullish FVG behind it, untaken
 * liquidity at 110, and every 5m bar since the break closing at 102.
 */
function baseContext(options: { breakType?: 'BOS' | 'CHOCH'; trend?: SMCFrameAnalysis['trend']; trigger?: Partial<StructureBreak> | null; fvg?: boolean } = {}): PlaybookContext {
  const c15 = flat('15m', 40, T, 102);
  c15[38] = { ...c15[38], open: 100, high: 103.2, low: 99.8, close: 103, volume: 300 };
  c15[39] = { ...c15[39], close: 102.5, high: 103 };
  const zoneBreak = structureBreak({ type: options.breakType ?? 'CHOCH', index: 38, time: c15[38].openTime, sweptLiquidityFirst: true, leftFvg: true });
  const armedAtBreak = c15[38].openTime + M15;
  const trigger = options.trigger === null ? null : structureBreak({ type: 'BOS', time: armedAtBreak + M5, breakClose: 101.9, ...(options.trigger ?? {}) });
  const trend = options.trend ?? 'NEUTRAL';
  return {
    symbol: 'SOLUSDT',
    now: T,
    candles: { '5m': flat('5m', 60, T, 102), '15m': c15, '1h': flat('1h', 30, T, 102), '4h': flat('4h', 30, T, 102) },
    frames: {
      '5m': frame('5m', { breaks: trigger ? [trigger] : [], latestBreak: trigger }),
      '15m': frame('15m', {
        latestBreak: zoneBreak, breaks: [zoneBreak], lastPrice: 102.5,
        fairValueGaps: options.fvg === false ? [] : [{ direction: 1, top: 101.5, bottom: 100.5, index: 37 }],
        liquidityPools: [{ direction: 1, price: 110, kind: 'SWING', firstIndex: 5, taken: false }],
      }),
      '1h': frame('1h', { trend }),
      '4h': frame('4h', { trend }),
    },
    dataIssues: {},
    execution: { ...EXECUTION },
    smcConfig: DEFAULT_SMC_CONFIG,
  };
}

const failedIds = (v: PlaybookVerdict) => v.failed.map((e) => e.ruleId);
const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const withParams = (pb: PlaybookDefinition, params: Partial<PlaybookDefinition['params']>): PlaybookDefinition => ({ ...pb, params: { ...pb.params, ...params } });

const REVERSAL = getPlaybook('sweep_mss_fvg_reversal');
const CONTINUATION = getPlaybook('bos_fvg_ob_continuation');
const BREAKOUT = getPlaybook('breakout_retest');

test('sweep reversal: a swept, displacing CHOCH with an FVG and a 5m trigger near it is ENTRY_ELIGIBLE with the structural plan', () => {
  const v = evaluatePlaybook(REVERSAL, baseContext(), 'LONG');

  assert.equal(v.verdict, 'ENTRY_ELIGIBLE', JSON.stringify(v.failed));
  assert.deepEqual(v.failed, []);
  assert.deepEqual(v.pending, []);
  assert.equal(v.evaluations.length, REVERSAL.rules.length);
  near(v.plan?.entry, 101.9);
  near(v.plan?.stop, 98.8); // protected swing 99 minus 0.2 ATR
  near(v.plan?.target, 110);
  assert.equal(v.armedAt, T - M15);
  assert.equal(v.triggeredAt, T - M15 + 2 * M5);
  for (const e of v.evaluations) assert.ok(e.reason.length > 0, `${e.ruleId} has no reason`);
});

test('every rule result carries the observed value and threshold it was judged on', () => {
  const v = evaluatePlaybook(REVERSAL, baseContext(), 'LONG');
  const rr = v.evaluations.find((e) => e.ruleId === 'net_reward_risk_above_minimum')!;
  assert.equal(rr.threshold, 1.5);
  assert.ok(typeof rr.observedValue === 'number' && rr.observedValue > 1.5);
  const displacement = v.evaluations.find((e) => e.ruleId === 'displacement_confirmed')!;
  assert.equal(displacement.evidenceTime, T - M15);
});

test('no 5m trigger yet inside the window: WATCH, and the execution gates are pending, not failed', () => {
  const v = evaluatePlaybook(REVERSAL, baseContext({ trigger: null }), 'LONG');

  assert.equal(v.verdict, 'WATCH');
  assert.deepEqual(failedIds(v), ['trigger_confirmed']);
  assert.deepEqual(v.pending, ['spread_within_limit', 'stop_geometry_valid', 'entry_not_chased', 'net_reward_risk_above_minimum']);
  assert.equal(v.plan, null);
});

test('no trigger and the window has run out: NO_TRADE as expired', () => {
  const v = evaluatePlaybook(withParams(REVERSAL, { maxTriggerBars: 2 }), baseContext({ trigger: null }), 'LONG');

  assert.equal(v.verdict, 'NO_TRADE');
  assert.ok(failedIds(v).includes('trigger_window_open'));
});

test('a 5m trigger that closed too far beyond the zone is a chase: NO_TRADE without a plan', () => {
  const v = evaluatePlaybook(REVERSAL, baseContext({ trigger: { breakClose: 104 } }), 'LONG');

  assert.equal(v.verdict, 'NO_TRADE');
  assert.ok(failedIds(v).includes('entry_not_chased'));
  assert.equal(v.plan, null);
});

test('a close beyond the stop after the break invalidates the setup, with the offending bar as evidence', () => {
  const ctx = baseContext();
  const bars = ctx.candles['5m']!;
  bars[57] = { ...bars[57], low: 98.0, close: 98.5 };

  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');

  assert.equal(v.verdict, 'NO_TRADE');
  const invalid = v.failed.find((e) => e.ruleId === 'setup_not_invalidated')!;
  assert.equal(invalid.evidenceTime, bars[57].openTime + M5);
});

test('the reversal needs a CHOCH and a sweep; a plain BOS is refused with the exact predicate', () => {
  const ctx = baseContext({ breakType: 'BOS' });
  ctx.frames['15m']!.latestBreak!.sweptLiquidityFirst = false;

  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');

  assert.equal(v.verdict, 'NO_TRADE');
  assert.ok(failedIds(v).includes('structure_break_in_direction'));
  assert.ok(failedIds(v).includes('liquidity_swept_before_break'));
});

test('the opposite direction is refused because the latest break points the other way', () => {
  const v = evaluatePlaybook(REVERSAL, baseContext(), 'SHORT');

  assert.equal(v.verdict, 'NO_TRADE');
  const rule = v.failed.find((e) => e.ruleId === 'structure_break_in_direction')!;
  assert.match(rule.reason, /latest zone-frame break is LONG/);
});

test('a missing frame is NO_TRADE naming the data issue, not an exception', () => {
  const ctx = baseContext();
  delete ctx.frames['4h'];
  ctx.dataIssues['4h'] = 'gap in 4h bars between 1 and 2';

  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');

  assert.equal(v.verdict, 'NO_TRADE');
  assert.match(v.failed.find((e) => e.ruleId === 'frames_present')!.reason, /gap in 4h bars/);
});

test('stale data is NO_TRADE even with a confirmed trigger', () => {
  const ctx = { ...baseContext(), now: T + 2 * M15 };
  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');
  assert.equal(v.verdict, 'NO_TRADE');
  assert.ok(failedIds(v).includes('data_fresh'));
});

test('an unknown spread fails the execution gate', () => {
  const ctx = baseContext();
  ctx.execution.spreadBps = null;
  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');
  assert.equal(v.verdict, 'NO_TRADE');
  assert.deepEqual(failedIds(v), ['spread_within_limit']);
});

test('net reward:risk counts fees and slippage: a near target is refused', () => {
  const ctx = baseContext();
  ctx.frames['15m']!.liquidityPools = [{ direction: 1, price: 105, kind: 'SWING', firstIndex: 5, taken: false }];
  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');
  assert.equal(v.verdict, 'NO_TRADE');
  assert.deepEqual(failedIds(v), ['net_reward_risk_above_minimum']);
});

test('evaluation never throws: a context that breaks derivation is NO_TRADE with the reason', () => {
  const ctx = baseContext();
  ctx.frames['15m'] = new Proxy(ctx.frames['15m']!, { get: () => { throw new Error('corrupt frame'); } });
  const v = evaluatePlaybook(REVERSAL, ctx, 'LONG');
  assert.equal(v.verdict, 'NO_TRADE');
  assert.match(v.failed[0].reason, /corrupt frame/);
});

test('continuation arms on the first 5m bar into the zone and is ENTRY_ELIGIBLE from the discount half of the leg', () => {
  const ctx = baseContext({ breakType: 'BOS', trend: 'LONG', trigger: { breakClose: 101.0 } });
  const v = evaluatePlaybook(CONTINUATION, ctx, 'LONG');

  assert.equal(v.verdict, 'ENTRY_ELIGIBLE', JSON.stringify(v.failed));
  assert.equal(v.armedAt, T - M15 + M5, 'the first 5m bar after the break trades down to the FVG top');
  near(v.plan?.entry, 101.0);
});

test('continuation refuses an entry in the premium half of the leg and refuses when the higher frames are not aligned', () => {
  const premium = evaluatePlaybook(CONTINUATION, baseContext({ breakType: 'BOS', trend: 'LONG' }), 'LONG');
  assert.equal(premium.verdict, 'NO_TRADE');
  assert.deepEqual(failedIds(premium), ['entry_in_discount']);

  const unaligned = evaluatePlaybook(CONTINUATION, baseContext({ breakType: 'BOS', trend: 'NEUTRAL', trigger: { breakClose: 101.0 } }), 'LONG');
  assert.equal(unaligned.verdict, 'NO_TRADE');
  assert.deepEqual(failedIds(unaligned), ['htf_aligned']);
});

test('continuation falls back to the order block of the break when it left no FVG', () => {
  const ctx = baseContext({ breakType: 'BOS', trend: 'LONG', trigger: { breakClose: 101.0 }, fvg: false });
  ctx.frames['15m']!.orderBlocks = [{ direction: 1, top: 101.5, bottom: 100.2, index: 33 }];
  const v = evaluatePlaybook(CONTINUATION, ctx, 'LONG');
  assert.equal(v.evaluations.find((e) => e.ruleId === 'entry_zone_present')!.observedValue, 'ORDER_BLOCK');
  assert.equal(v.verdict, 'ENTRY_ELIGIBLE', JSON.stringify(v.failed));
});

function breakoutContext(retestClose = 102.3): PlaybookContext {
  const ctx = baseContext({ breakType: 'BOS', trigger: { breakClose: 102.4 } });
  const bars = ctx.candles['5m']!;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].openTime >= T - M15) bars[i] = { ...bars[i], open: 102.2, high: 102.6, low: 101.8, close: retestClose };
  }
  return ctx;
}

test('breakout retest: a high-volume break retested on 5m and confirmed is ENTRY_ELIGIBLE with the stop under the retest', () => {
  const v = evaluatePlaybook(BREAKOUT, breakoutContext(), 'LONG');

  assert.equal(v.verdict, 'ENTRY_ELIGIBLE', JSON.stringify(v.failed));
  assert.equal(v.armedAt, T - M15 + M5);
  near(v.plan?.stop, 101.6); // retest low 101.8 minus 0.2 ATR
  const volume = v.evaluations.find((e) => e.ruleId === 'breakout_volume')!;
  near(volume.observedValue as number, 3);
});

test('breakout retest: a 15m close back through the level band is a failed reclaim', () => {
  const ctx = breakoutContext();
  const c15 = ctx.candles['15m']!;
  c15[39] = { ...c15[39], low: 101.5, close: 101.7 };
  const v = evaluatePlaybook(BREAKOUT, ctx, 'LONG');
  assert.equal(v.verdict, 'NO_TRADE');
  assert.ok(failedIds(v).includes('setup_not_invalidated'));
});

test('breakout retest: a 5m touch that does not close back above the level does not arm', () => {
  const v = evaluatePlaybook(BREAKOUT, breakoutContext(101.95), 'LONG');
  assert.equal(v.armedAt, null);
  assert.ok(failedIds(v).includes('armed'));
});

test('the registry is versioned, covers every stage, and refuses unsafe definitions', () => {
  const playbooks = listPlaybooks();
  assert.deepEqual(playbooks.map((p) => `${p.id}@${p.version}`), ['sweep_mss_fvg_reversal@2', 'bos_fvg_ob_continuation@2', 'breakout_retest@2']);
  for (const pb of playbooks) assert.equal(pb.params.maxTriggerBars, 6);

  assert.throws(() => validateRegistry([REVERSAL, REVERSAL]), /duplicate playbook/);
  assert.throws(() => validateRegistry([{ ...REVERSAL, rules: [...REVERSAL.rules, 'made_up' as never] }]), /unknown rules made_up/);
  assert.throws(() => validateRegistry([{ ...REVERSAL, rules: REVERSAL.rules.filter((r) => r !== 'net_reward_risk_above_minimum') }]), /mandatory rule net_reward_risk_above_minimum/);
  assert.throws(() => validateRegistry([{ ...REVERSAL, version: 0 }]), /version/);
  assert.throws(() => validateRegistry([withParams(CONTINUATION, { maxLegPosition: undefined })]), /maxLegPosition/);
  assert.throws(() => validateRegistry([withParams(REVERSAL, { maxTriggerBars: 3 })]), /trigger swing length 3 must be below maxTriggerBars 3/);
});

test('closedBars drops the forming bar and refuses gaps, invalid bars and conflicting duplicates', () => {
  const bars = flat('5m', 5, T, 100);
  const forming = { ...bars[4], openTime: T };
  assert.equal(closedBars('5m', [...bars, forming, bars[2]], T).length, 5);
  assert.throws(() => closedBars('5m', [bars[0], bars[2]], T), /gap/);
  assert.throws(() => closedBars('5m', [...bars.slice(0, 4), { ...bars[4], high: 90 }], T), /invalid/);
  assert.throws(() => closedBars('5m', [...bars, { ...bars[4], close: 100.2 }], T), /conflicting duplicate/);
});

/** Deterministic random walk with valid, contiguous bars. */
function walk(frame: SMCFrame, count: number, seed: number): Candle[] {
  let state = seed;
  const rand = () => { state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296; return state / 4_294_967_296; };
  let price = 150;
  return Array.from({ length: count }, (_, i) => {
    const open = price;
    const close = open * (1 + (rand() - 0.5) * 0.01);
    price = close;
    const wick = open * rand() * 0.002;
    return { openTime: T - (count - i) * MS[frame], open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 50 + rand() * 100 };
  });
}

test('end to end on generated candles: the real SMC analysis feeds every playbook, and each verdict is consistent', () => {
  const ctx = buildPlaybookContext('SOLUSDT', T, {
    '5m': walk('5m', 300, 1), '15m': walk('15m', 200, 2), '1h': walk('1h', 120, 3), '4h': walk('4h', 80, 4),
  }, EXECUTION);

  assert.deepEqual(ctx.dataIssues, {});
  const verdicts = evaluateAllPlaybooks(ctx);
  assert.equal(verdicts.length, 6);
  for (const v of verdicts) {
    assert.ok(['ENTRY_ELIGIBLE', 'WATCH', 'NO_TRADE'].includes(v.verdict));
    assert.ok(v.evaluations.length > 0);
    if (v.verdict === 'ENTRY_ELIGIBLE') { assert.ok(v.plan); assert.deepEqual(v.failed, []); }
    if (v.verdict !== 'ENTRY_ELIGIBLE') assert.equal(v.plan, null);
    if (v.verdict === 'WATCH') assert.ok(v.failed.every((e) => e.stage === 'TRIGGER'));
  }
});

test('a frame with a gap is left out and every playbook says why', () => {
  const m5 = walk('5m', 300, 1);
  m5.splice(150, 1);
  const ctx = buildPlaybookContext('SOLUSDT', T, { '5m': m5, '15m': walk('15m', 200, 2), '1h': walk('1h', 120, 3), '4h': walk('4h', 80, 4) }, EXECUTION);

  assert.match(ctx.dataIssues['5m'] ?? '', /gap in 5m bars/);
  for (const v of evaluateAllPlaybooks(ctx)) {
    assert.equal(v.verdict, 'NO_TRADE');
    assert.match(v.failed.find((e) => e.ruleId === 'frames_present')!.reason, /gap in 5m bars/);
  }
});
