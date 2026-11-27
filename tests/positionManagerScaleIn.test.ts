import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, carryAfterScaleIn, DEFAULT_PM_CONFIG, initState, isStale } from '../src/position/PositionManager.js';
import type { LotRules, PmState } from '../src/position/PositionManager.js';
import type { Position } from '../src/types.js';

const cfg = DEFAULT_PM_CONFIG;
const lot: LotRules = { step: 0.001, minQty: 0.001, minNotional: 5 };
const NOW = 1_800_000_000_000;
const BREAKEVEN = 100 * (1 + cfg.costBufferRate);

const longPos = (entry: number, qty: number, serverSl: number, extra: Partial<Position> = {}): Position => ({
  symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry, qty, mark: entry, serverSl: String(serverSl),
  serverTp: '106', initialRisk: 2, ...extra,
} as unknown as Position);

/** Entry 100 / stop 98 / 1R 2. TP1 is taken at 102, the stop moves to breakeven, then `addQty` is added at `addPrice`. */
function afterTp1AndAdd(addPrice: number, addQty = 65) {
  const first = advance(initState(longPos(100, 100, 98), NOW, cfg)!, { mark: 102, qty: 100, atr: 1, vol: 'MEDIUM', lot }, cfg, NOW);
  const tp1 = first.actions.find((a) => a.type === 'REDUCE');
  assert.ok(tp1 && tp1.type === 'REDUCE' && tp1.reason === 'TP1', 'TP1 must fire at 1R');
  const remaining = 100 - tp1.qty;
  const averaged = (remaining * 100 + addQty * addPrice) / (remaining + addQty);
  const venue = longPos(averaged, remaining + addQty, BREAKEVEN);
  return { previous: first.state, venue, averaged };
}

test('a scale-in above the breakeven stop does not take TP1 a second time', () => {
  const { previous, venue, averaged } = afterTp1AndAdd(103);
  assert.ok(isStale(previous, venue), 'the venue position no longer matches the state');
  const rebuilt = initState(venue, NOW, cfg)!;
  const carried = carryAfterScaleIn(previous, rebuilt);
  const next = advance(carried, { mark: averaged + 2, qty: venue.qty, atr: 1, vol: 'MEDIUM', lot }, cfg, NOW);
  assert.equal(next.actions.some((a) => a.type === 'REDUCE' && a.reason === 'TP1'), false, 'TP1 was already taken');
  assert.equal(carried.tp1Done, true);
});

test('the same scale-in without the carry-over is the bug: TP1 fires again on the rebuilt state', () => {
  // Documents why carryAfterScaleIn exists: a bare rebuild forgets TP1
  const { venue, averaged } = afterTp1AndAdd(103);
  const bare = initState(venue, NOW, cfg)!;
  assert.equal(bare.tp1Done, false);
  const next = advance(bare, { mark: averaged + 2, qty: venue.qty, atr: 1, vol: 'MEDIUM', lot }, cfg, NOW);
  assert.ok(next.actions.some((a) => a.type === 'REDUCE' && a.reason === 'TP1'));
});

test('a scale-in at the original entry keeps TP1 taken and the phase protected', () => {
  const { previous, venue } = afterTp1AndAdd(100);
  const carried = carryAfterScaleIn(previous, initState(venue, NOW, cfg)!);
  assert.deepEqual([carried.tp1Done, carried.phase], [true, 'PROTECTED']);
});

test('the 1R stays the one set at entry across a scale-in, so TP2 is still measured from the original risk', () => {
  const { previous, venue, averaged } = afterTp1AndAdd(103);
  const carried = carryAfterScaleIn(previous, initState(venue, NOW, cfg)!);
  assert.equal(carried.oneR, 2);
  assert.ok(averaged > 101 && averaged < 102, 'the average entry moved, the 1R did not');
});

test('TP2 already taken stays taken across a scale-in', () => {
  const prev: PmState = { ...initState(longPos(100, 100, 98), NOW, cfg)!, tp1Done: true, tp2Done: true, phase: 'TRAILING' };
  const carried = carryAfterScaleIn(prev, initState(longPos(101, 110, BREAKEVEN), NOW, cfg)!);
  assert.deepEqual([carried.tp2Done, carried.phase], [true, 'TRAILING']);
});

test('a side change is a different position and keeps nothing', () => {
  const prev: PmState = { ...initState(longPos(100, 100, 98), NOW, cfg)!, tp1Done: true, phase: 'PROTECTED' };
  const short = initState(longPos(100, 50, 102, { side: 'SHORT' } as Partial<Position>), NOW, cfg)!;
  const carried = carryAfterScaleIn(prev, short);
  assert.equal(carried.tp1Done, false);
  assert.equal(carried.side, 'SHORT');
});

test('a fresh position with nothing taken carries nothing and rebuilds as before', () => {
  const prev = initState(longPos(100, 100, 98), NOW, cfg)!;
  const rebuilt = initState(longPos(101, 80, 98), NOW, cfg)!;
  assert.deepEqual(carryAfterScaleIn(prev, rebuilt), { ...rebuilt, oneR: prev.oneR });
});
