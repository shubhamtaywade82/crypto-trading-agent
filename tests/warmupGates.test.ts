import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MicrostructureEngine } from '../src/microstructure/MicrostructureEngine.js';
import { frictionVerdict } from '../src/microstructure/FrictionGate.js';

const T0 = 1700000000000;

test('MicrostructureEngine bookWindowMs and cvdAnchorSet track live duration and reset on resync', () => {
  const engine = new MicrostructureEngine('BTCUSDT');
  assert.equal(engine.bookWindowMs(T0), 0);
  assert.equal(engine.cvdAnchorSet(T0), false);

  // Load snapshot and diff
  engine.onSnapshot({
    lastUpdateId: 100,
    bids: [{ price: 100, qty: 1 }],
    asks: [{ price: 101, qty: 1 }],
  });
  engine.onDepth({ U: 99, u: 101, pu: 98, E: T0, b: [], a: [] }, T0);
  engine.sample(T0);

  // Now liveSince is set to T0
  assert.equal(engine.bookWindowMs(T0 + 5000), 5000);

  // Invalidate resets liveSince
  engine.invalidate('test resync');
  assert.equal(engine.bookWindowMs(T0 + 10_000), 0);
});

test('entryFriction and frictionVerdict enforce minBookWindowMs and minCvdWindowMs', () => {
  const engine = new MicrostructureEngine('BTCUSDT');
  engine.onSnapshot({
    lastUpdateId: 100,
    bids: [{ price: 100, qty: 10 }],
    asks: [{ price: 101, qty: 10 }],
  });
  engine.onDepth({ U: 99, u: 101, pu: 98, E: T0, b: [], a: [] }, T0);
  engine.sample(T0);

  // At T0, bookWindow is 0ms. Require 600,000ms (10 min)
  const blocked = engine.entryFriction('buy', 1000, T0, 600_000, 300_000);
  assert.equal(blocked.status, 'BLOCK');
  assert.match(blocked.reasons[0]!, /book warm-up incomplete/);

  // At T0 + 600,000ms with a fresh depth update, bookWindow reaches 600,000ms
  engine.onDepth({ U: 102, u: 103, pu: 101, E: T0 + 600_000, b: [], a: [] }, T0 + 600_000);
  engine.sample(T0 + 600_000);
  assert.equal(engine.bookWindowMs(T0 + 600_000), 600_000);

  // Using frictionVerdict with warm-up parameters
  const fakeSource = { engine: () => engine };
  const verdictEarly = frictionVerdict({
    mode: 'on',
    source: fakeSource,
    symbol: 'BTCUSDT',
    side: 'buy',
    notional: 1000,
    now: T0 + 1000,
    minBookWindowMs: 600_000,
  });
  assert.equal(verdictEarly.allowed, false);
  assert.match(verdictEarly.reason, /book warm-up incomplete/);
});
