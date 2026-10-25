import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entrySide, frictionVerdict } from '../src/microstructure/FrictionGate.js';
import { DEFAULT_MICRO_OPTIONS, MicrostructureEngine } from '../src/microstructure/MicrostructureEngine.js';
import { microConfigFromEnv } from '../src/microstructure/MicrostructureFeed.js';

const T0 = Date.UTC(2026, 9, 25, 9, 0);

/** 100.00 / 100.02 book: deep asks (500 per level), thin bids (2 per level), 200 levels a side. */
function engine(bidQty = 2, askQty = 500) {
  const e = new MicrostructureEngine('SOLUSDT', DEFAULT_MICRO_OPTIONS);
  const bids = Array.from({ length: 200 }, (_, i) => ({ price: Number((100 - i * 0.01).toFixed(2)), qty: bidQty }));
  const asks = Array.from({ length: 200 }, (_, i) => ({ price: Number((100.02 + i * 0.01).toFixed(2)), qty: askQty }));
  e.onSnapshot({ lastUpdateId: 10, bids, asks });
  e.onDepth({ U: 10, u: 11, pu: 9, E: T0, b: [], a: [] }, T0);
  return e;
}

test('entry friction walks the entry side only: a deep ask side passes a buy that a thin bid side blocks as a sell', () => {
  const e = engine();
  const buy = e.entryFriction('buy', 5_000, T0);
  assert.equal(buy.status, 'OK');
  assert.ok(buy.slipBps! > 0.9 && buy.slipBps! < 1.1, String(buy.slipBps)); // 5k fills at the 100.02 touch: 1bp from mid
  assert.ok(Math.abs(buy.spreadBps! - 2) < 1e-6);

  const sell = e.entryFriction('sell', 5_000, T0);
  assert.equal(sell.status, 'BLOCK');
  assert.deepEqual(sell.reasons, ['sell slippage 13.0bps > 10']); // $5k walks 25 levels of 2 SOL

  const huge = e.entryFriction('buy', 50_000_000, T0);
  assert.equal(huge.status, 'BLOCK');
  assert.deepEqual(huge.reasons, ['buy slippage: known book too thin']);
});

test('entry friction grades ELEVATED above half a limit and BLOCKs a wide spread', () => {
  const elevated = engine(500, 500).entryFriction('buy', 700_000, T0);
  assert.equal(elevated.status, 'ELEVATED');
  assert.deepEqual(elevated.reasons, ['buy slippage 7.5bps']); // above half the 10bps limit, below the limit
  assert.equal(engine(500, 500).entryFriction('buy', 300_000, T0).status, 'OK'); // 3.5bps

  const wide = new MicrostructureEngine('SOLUSDT');
  wide.onSnapshot({ lastUpdateId: 1, bids: [{ price: 100, qty: 1_000 }], asks: [{ price: 100.1, qty: 1_000 }] });
  wide.onDepth({ U: 1, u: 2, pu: 0, E: T0, b: [], a: [] }, T0);
  const r = wide.entryFriction('buy', 100, T0);
  assert.equal(r.status, 'BLOCK');
  assert.match(r.reasons[0], /^spread 10\.0bps > 5$/);
});

test('a book that is not live always blocks, naming why', () => {
  const stale = engine();
  assert.deepEqual(
    [stale.entryFriction('buy', 100, T0 + 6_000).status, stale.entryFriction('buy', 100, T0 + 6_000).reasons[0]],
    ['BLOCK', 'book stale: no depth update for 6s'],
  );
  stale.invalidate('stream reconnecting');
  const syncing = stale.entryFriction('buy', 100, T0);
  assert.equal(syncing.status, 'BLOCK');
  assert.equal(syncing.reasons[0], 'book syncing: stream reconnecting');
  assert.equal(syncing.slipBps, null);
});

test('the gate refuses BLOCK when on, only reports it in shadow, and skips measurement when off', () => {
  const source = { engine: (s: string) => (s === 'SOLUSDT' ? engine() : undefined) };
  const ask = (mode: 'on' | 'shadow' | 'off', side: 'buy' | 'sell') => frictionVerdict({ mode, source, symbol: 'SOLUSDT', side, notional: 5_000, now: T0 });

  assert.deepEqual([ask('on', 'buy').allowed, ask('on', 'buy').status], [true, 'OK']);
  const blocked = ask('on', 'sell');
  assert.deepEqual([blocked.allowed, blocked.status], [false, 'BLOCK']);
  assert.match(blocked.reason, /sell slippage/);
  assert.ok(blocked.slipBps! > 10);

  const shadow = ask('shadow', 'sell');
  assert.deepEqual([shadow.allowed, shadow.status], [true, 'BLOCK']);

  assert.deepEqual(ask('off', 'sell'), { allowed: true, mode: 'off', status: 'UNMEASURED', reason: 'friction gate off', spreadBps: null, slipBps: null });
});

test('the gate fails closed without a feed or without a book for the symbol', () => {
  const noFeed = frictionVerdict({ mode: 'on', source: null, symbol: 'SOLUSDT', side: 'buy', notional: 100, now: T0 });
  assert.deepEqual([noFeed.allowed, noFeed.status, noFeed.reason], [false, 'BLOCK', 'microstructure feed not running']);
  const unknown = frictionVerdict({ mode: 'on', source: { engine: () => undefined }, symbol: 'DOGEUSDT', side: 'buy', notional: 100, now: T0 });
  assert.deepEqual([unknown.allowed, unknown.reason], [false, 'no order book tracked for DOGEUSDT']);
  assert.equal(frictionVerdict({ mode: 'shadow', source: null, symbol: 'SOLUSDT', side: 'buy', notional: 100, now: T0 }).allowed, true);
});

test('entry side follows the executor: shorts, hedges and funding shorts sell', () => {
  assert.deepEqual(['OPEN_LONG', 'OPEN_SHORT', 'OPEN_HEDGE', 'OPEN_FUNDING_SHORT'].map(entrySide), ['buy', 'sell', 'sell', 'sell']);
});

test('the gate defaults on and cannot be on without the feed it measures with', () => {
  assert.equal(microConfigFromEnv({}).entryGate, 'on');
  assert.equal(microConfigFromEnv({ MICRO_ENTRY_GATE: 'shadow' }).entryGate, 'shadow');
  assert.throws(() => microConfigFromEnv({ MICROSTRUCTURE: 'off' }), /MICRO_ENTRY_GATE=on needs the order-book feed/);
  assert.deepEqual([microConfigFromEnv({ MICROSTRUCTURE: 'off', MICRO_ENTRY_GATE: 'off' }).enabled, microConfigFromEnv({ MICROSTRUCTURE: 'off', MICRO_ENTRY_GATE: 'off' }).entryGate], [false, 'off']);
  assert.throws(() => microConfigFromEnv({ MICRO_ENTRY_GATE: 'maybe' }));
});
