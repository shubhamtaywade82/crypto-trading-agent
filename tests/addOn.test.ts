import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLevelsOk, addRoomOf, ADD_CAP_MULTIPLE, capAddSize } from '../src/position/addOn.js';
import { carryAfterScaleIn, initState } from '../src/position/PositionManager.js';
import type { PmState } from '../src/position/PositionManager.js';
import { DEFAULT_PM_CONFIG } from '../src/position/PositionManager.js';
import type { Position, RiskDecision } from '../src/types.js';

const NOW = 1_800_000_000_000;
const cfg = DEFAULT_PM_CONFIG;

const longPos = (entry: number, qty: number, serverSl: number): Position => ({
  symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry, qty, mark: entry, serverSl: String(serverSl),
  serverTp: '106', initialRisk: 2,
} as unknown as Position);

/** A managed long opened at 100 with 100 units, 1R = 2, after TP1 has been taken (35 sold, stop at breakeven). */
function afterTp1(): PmState {
  return { ...initState(longPos(100, 100, 98), NOW, cfg)!, tp1Done: true, reducedQty: 35 };
}

test('an add is refused before TP1 is taken, however much room the cap would give', () => {
  const state = initState(longPos(100, 100, 98), NOW, cfg)!;
  const room = addRoomOf(state, 100);
  assert.deepEqual(room, { ok: false, reason: 'TP1 not yet taken' });
});

test('a position the manager does not track has no add room', () => {
  assert.deepEqual(addRoomOf(undefined, 65), { ok: false, reason: 'position is not managed (no manager state)' });
});

test('after TP1 the room is the 2x entry cap less what is held', () => {
  const room = addRoomOf(afterTp1(), 65);
  assert.deepEqual(room, { ok: true, maxQty: 2 * 100 - 65 });
});

test('the room closes when the held size reaches the cap', () => {
  const room = addRoomOf(afterTp1(), 200);
  assert.equal(room.ok, false);
  assert.match(room.ok ? '' : room.reason, /at the 2x entry cap/);
});

test('the cap is on the entry size, not on what has been bought since: the entry size survives a scale-in', () => {
  const prev = afterTp1();
  const venue = longPos(101.5, 130, 100.12);
  const carried = carryAfterScaleIn(prev, initState(venue, NOW, cfg)!);
  assert.equal(carried.entryQty, 100);
  assert.equal(carried.initialQty, 165, 'the acquired total still counts the add');
  assert.deepEqual(addRoomOf(carried, 130), { ok: true, maxQty: 200 - 130 });
});

test('a state written before add-ons existed falls back to its acquired size as the entry size', () => {
  const legacy = { ...afterTp1(), entryQty: undefined };
  assert.deepEqual(addRoomOf(legacy, 65), { ok: true, maxQty: 2 * 100 - 65 });
});

test('the cap multiple is 2', () => {
  assert.equal(ADD_CAP_MULTIPLE, 2);
});

test('an add keeps a stop on the protective side of its price', () => {
  assert.equal(addLevelsOk('LONG', 100.12, 103), true);
  assert.equal(addLevelsOk('LONG', 104, 103), false, 'a long stop above the price protects nothing');
  assert.equal(addLevelsOk('SHORT', 97, 95), true);
  assert.equal(addLevelsOk('SHORT', 93, 95), false);
  assert.equal(addLevelsOk('LONG', Number.NaN, 103), false);
});

const approved: RiskDecision = { approved: true, positionSizeUsdt: 5_000, leverage: 8, marginType: 'ISOLATED', liqBufferAtr: 3, reason: 'size' };

test('an add is capped to the room in notional terms', () => {
  const capped = capAddSize(approved, 10, 100);
  assert.equal(capped.positionSizeUsdt, 1_000);
  assert.equal(capped.approved, true);
});

test('an add that already fits the room is left as sized by the risk gate', () => {
  assert.equal(capAddSize(approved, 100, 100), approved);
});

test('an add with no room left is refused, not sized to zero', () => {
  const refused = capAddSize(approved, 0, 100);
  assert.equal(refused.approved, false);
  assert.equal(refused.reason, 'add-on cap reached');
});

test('a decision the gate already refused stays refused', () => {
  const refused = { ...approved, approved: false, reason: 'capacity' };
  assert.equal(capAddSize(refused, 10, 100), refused);
});
