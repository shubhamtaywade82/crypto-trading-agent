import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '../src/types.js';
import { DEFAULT_SMC_CONFIG, type SMCFrame, type SMCFrameAnalysis, type StructureBreak } from '../src/strategies/smc-ml/types.js';
import { deriveFacts, evaluatePlaybook, getPlaybook, validateRegistry, type PlaybookContext, type PlaybookDefinition } from '../src/playbooks/index.js';

/**
 * Tests for the experiment-facing playbook additions: the session_in_window rule (killzones as an ablation component)
 * and the zoneKinds arming parameter (FVG vs order block as an ablation component). The context shape mirrors
 * tests/playbooks.test.ts: hand-built frames so each rule's evidence is exact.
 */

const M5 = 5 * 60_000;
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * 60 * 60_000;
const MS: Record<SMCFrame, number> = { '5m': M5, '15m': M15, '1h': H1, '4h': H4, '1d': 24 * H1 };
/** A multiple of 4h, and exactly UTC midnight: offsets then pick a time of day without breaking frame freshness. */
const T = 118_056 * H4;
const EXECUTION = { spreadBps: 2, takerFeeRate: 0.0004, slippageRate: 0.0002 };

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

/** The eligible sweep-reversal context of tests/playbooks.test.ts, plus an order block behind the protected swing. */
function baseContext(offsetMs = 0): PlaybookContext {
  const end = T + offsetMs;
  const c15 = flat('15m', 40, end, 102);
  c15[38] = { ...c15[38], open: 100, high: 103.2, low: 99.8, close: 103, volume: 300 };
  c15[39] = { ...c15[39], close: 102.5, high: 103 };
  const zoneBreak = structureBreak({ type: 'CHOCH', index: 38, time: c15[38].openTime, sweptLiquidityFirst: true, leftFvg: true });
  const armedAtBreak = c15[38].openTime + M15;
  const trigger = structureBreak({ type: 'BOS', time: armedAtBreak + M5, breakClose: 101.9 });
  return {
    symbol: 'SOLUSDT',
    now: end,
    candles: { '5m': flat('5m', 60, end, 102), '15m': c15, '1h': flat('1h', 30, end, 102), '4h': flat('4h', 30, end, 102) },
    frames: {
      '5m': frame('5m', { breaks: [trigger], latestBreak: trigger }),
      '15m': frame('15m', {
        latestBreak: zoneBreak, breaks: [zoneBreak], lastPrice: 102.5,
        fairValueGaps: [{ direction: 1, top: 101.5, bottom: 100.5, index: 37 }],
        orderBlocks: [{ direction: 1, top: 101.8, bottom: 100.8, index: 33 }],
        liquidityPools: [{ direction: 1, price: 110, kind: 'SWING', firstIndex: 5, taken: false }],
      }),
      '1h': frame('1h', { trend: 'NEUTRAL' }),
      '4h': frame('4h', { trend: 'NEUTRAL' }),
    },
    dataIssues: {},
    execution: { ...EXECUTION },
    smcConfig: DEFAULT_SMC_CONFIG,
  };
}

const REVERSAL = getPlaybook('sweep_mss_fvg_reversal');
const CONTINUATION = getPlaybook('bos_fvg_ob_continuation');

const withSession = (pb: PlaybookDefinition, windows: PlaybookDefinition['params']['sessionWindows']): PlaybookDefinition =>
  ({ ...pb, rules: [...pb.rules, 'session_in_window'], params: { ...pb.params, sessionWindows: windows } });

const ICT = [
  { name: 'london_open', startHourUtc: 7, endHourUtc: 10 },
  { name: 'new_york_open', startHourUtc: 12, endHourUtc: 15 },
];

const INSIDE_NY = 12 * H1 + 50 * 60_000; // 12:50 UTC, inside new_york_open
const INSIDE_LDN = 7 * H1 + 50 * 60_000; // 07:50 UTC, inside london_open
const OUTSIDE = 10 * H1 + 30 * 60_000;   // 10:30 UTC, between the killzones

test('session_in_window: an eligible setup stays eligible inside the window and is refused outside it', () => {
  const inside = evaluatePlaybook(withSession(REVERSAL, ICT), baseContext(INSIDE_NY), 'LONG');
  assert.equal(inside.verdict, 'ENTRY_ELIGIBLE');
  const session = inside.evaluations.find((e) => e.ruleId === 'session_in_window')!;
  assert.ok(session.passed);
  assert.match(session.reason, /new_york_open/);

  const early = evaluatePlaybook(withSession(REVERSAL, ICT), baseContext(INSIDE_LDN), 'LONG');
  assert.equal(early.verdict, 'ENTRY_ELIGIBLE');
  assert.match(early.evaluations.find((e) => e.ruleId === 'session_in_window')!.reason, /london_open/);

  const outside = evaluatePlaybook(withSession(REVERSAL, ICT), baseContext(OUTSIDE), 'LONG');
  assert.equal(outside.verdict, 'NO_TRADE');
  const failed = outside.failed.find((e) => e.ruleId === 'session_in_window')!;
  assert.ok(!failed.passed);
  assert.match(failed.reason, /outside every session window/);

  // Without the session component the same context is eligible at the same clock time
  assert.equal(evaluatePlaybook(REVERSAL, baseContext(OUTSIDE), 'LONG').verdict, 'ENTRY_ELIGIBLE');
});

test('session_in_window fails closed without windows, and the registry refuses such a definition', () => {
  const noWindows: PlaybookDefinition = { ...REVERSAL, rules: [...REVERSAL.rules, 'session_in_window'] };
  const v = evaluatePlaybook(noWindows, baseContext(INSIDE_NY), 'LONG');
  assert.equal(v.verdict, 'NO_TRADE');
  assert.match(v.failed.find((e) => e.ruleId === 'session_in_window')!.reason, /defines no session windows/);

  assert.throws(() => validateRegistry([noWindows]), /session_in_window needs sessionWindows/);
  assert.throws(
    () => validateRegistry([withSession(REVERSAL, [{ name: 'backwards', startHourUtc: 10, endHourUtc: 9 }])]),
    /must start before it ends/,
  );
  assert.throws(
    () => validateRegistry([withSession(REVERSAL, [{ name: 'bad', startHourUtc: 25, endHourUtc: 26 }])]),
    /invalid UTC hours/,
  );
  assert.doesNotThrow(() => validateRegistry([withSession(REVERSAL, ICT)]));
});

test('zoneKinds: the continuation arms on the order block when the FVG is excluded, and on the FVG when it is not', () => {
  const obOnly: PlaybookDefinition = { ...CONTINUATION, params: { ...CONTINUATION.params, zoneKinds: ['ORDER_BLOCK'] } };
  const factsOb = deriveFacts(baseContext(INSIDE_NY), obOnly, 'LONG');
  assert.ok(factsOb.zone);
  assert.equal(factsOb.zone.kind, 'ORDER_BLOCK');
  assert.equal(factsOb.zone.top, 101.8);
  assert.ok(factsOb.armedAt !== null, 'the 5m bar trades into the order block');

  const fvgOnly: PlaybookDefinition = { ...CONTINUATION, params: { ...CONTINUATION.params, zoneKinds: ['FVG'] } };
  const factsFvg = deriveFacts(baseContext(INSIDE_NY), fvgOnly, 'LONG');
  assert.equal(factsFvg.zone!.kind, 'FVG');
  assert.equal(factsFvg.zone!.top, 101.5);

  // Default (no zoneKinds): registry behaviour, FVG preferred over the order block
  const factsDefault = deriveFacts(baseContext(INSIDE_NY), CONTINUATION, 'LONG');
  assert.equal(factsDefault.zone!.kind, 'FVG');
});

test('zoneKinds is validated: unknown kinds and an order-block-only sweep reversal are refused', () => {
  assert.throws(
    () => validateRegistry([{ ...CONTINUATION, params: { ...CONTINUATION.params, zoneKinds: [] } }]),
    /zoneKinds cannot be empty/,
  );
  assert.throws(
    () => validateRegistry([{ ...CONTINUATION, params: { ...CONTINUATION.params, zoneKinds: ['LEVEL'] as unknown as PlaybookDefinition['params']['zoneKinds'] } }]),
    /may only contain FVG or ORDER_BLOCK/,
  );
  assert.throws(
    () => validateRegistry([{ ...REVERSAL, params: { ...REVERSAL.params, zoneKinds: ['ORDER_BLOCK'] } }]),
    /needs an FVG zone/,
  );
  assert.doesNotThrow(() => validateRegistry([{ ...CONTINUATION, params: { ...CONTINUATION.params, zoneKinds: ['FVG'] } }]));
});
