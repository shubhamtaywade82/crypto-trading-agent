import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle, Position } from '../src/types.js';
import { TrailingShadow } from '../src/trailing/shadow.js';

// A steady uptrend: every ATR/chandelier policy has a stop well above the far initial SL of 10.
const uptrend = (): Candle[] => Array.from({ length: 60 }, (_, i) => ({
  openTime: i * 900_000, open: 50 + i, high: 51.5 + i, low: 49.5 + i, close: 51 + i, volume: 1,
}));

const longPosition = (mark: number): Position => ({
  id: 't1', symbol: 'SOLUSDT', side: 'LONG', strategy: 'ADAPTIVE-ST-ζ', entry: 60, qty: 1,
  mark, upnl: 0, upnlPct: 0, leverage: 3, marginType: 'ISOLATED', liqDistancePct: null,
  serverSl: '10', serverTp: '200', initialRisk: 50,
});

test('should log a shadow stop move, send nothing, and forget the position once it closes', async () => {
  const logs: string[] = [];
  let klineCalls = 0;
  const shadow = new TrailingShadow({
    getKlines: async () => { klineCalls += 1; return uptrend(); },
    log: (message) => logs.push(message),
    now: () => 1_000,
  });

  const first = await shadow.observe([longPosition(110)]);
  assert.equal(first.length, 1);
  assert.equal(first[0].action, 'MOVE_STOP');
  assert.ok((first[0].stopPrice ?? 0) > 10 && (first[0].stopPrice ?? 0) < 110, 'a protective stop above the initial SL');
  assert.match(logs[0], /^TRAIL \(shadow\) SOLUSDT LONG: would move stop to /);

  const again = await shadow.observe([longPosition(110)]);
  assert.deepEqual(again, [], 'the ratchet holds: the same context moves nothing twice');
  assert.equal(klineCalls, 1, 'candles are cached between passes');

  await shadow.observe([]);
  const reopened = await shadow.observe([longPosition(110)]);
  assert.equal(reopened[0]?.action, 'MOVE_STOP', 'a closed position starts a fresh book');
});
