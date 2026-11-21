import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RestBackoffError, RestGuard, guardUsdmClient } from '../src/core/adapters/binance/restGuard.js';

const MINUTE = 60_000;
const START = 1700000000000;

function clock(start = START) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

test('RestGuard seeds weight limit from exchangeInfo rateLimits array', () => {
  const guard = new RestGuard();
  guard.seedFromRateLimits([
    { rateLimitType: 'ORDERS', interval: 'MINUTE', limit: 1200 },
    { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', limit: 4800 },
  ]);
  // 90% of 4800 is 4320; 3000 should pass
  assert.doesNotThrow(() => guard.assertOpen(3000));
});

test('protective writes bypass local weight ceiling but not venue ban', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now, weightLimit: 2400 });

  // First call in the minute receives the response with high used weight
  assert.equal(await guard.call(async () => 'init', () => 2300, false), 'init');

  // Now inside this minute with used weight 2300 >= 2160, non-protective call is rejected
  await assert.rejects(
    guard.call(async () => 'regular', () => 2300, false),
    RestBackoffError,
  );

  // Protective write (e.g. reduce-only emergency close) bypasses local ceiling
  const protectiveRes = await guard.call(async () => 'protective_success', () => 2300, true);
  assert.equal(protectiveRes, 'protective_success');

  // Venue rate limit (code -1003 with Retry-After)
  guard.observe({ code: -1003, headers: { 'retry-after': '60' }, message: 'Too many requests' });

  // Both regular and protective calls are refused during venue ban
  await assert.rejects(
    guard.call(async () => 'regular', () => 0, false),
    RestBackoffError,
  );
  await assert.rejects(
    guard.call(async () => 'protective', () => 0, true),
    RestBackoffError,
  );
});

test('guardUsdmClient automatically identifies cancel and reduceOnly orders as protective', async () => {
  const c = clock();
  const guard = new RestGuard({ now: c.now, weightLimit: 2400 });

  let cancelled = false;
  let closeSent = false;
  let openSent = false;

  const mockClient = {
    getRateLimitStates: () => ({ 'x-mbx-used-weight-1m': 2300 }),
    async ping() { return {}; },
    async cancelOrder() { cancelled = true; return { status: 'CANCELLED' }; },
    async placeOrder(params: { reduceOnly?: boolean }) {
      if (params.reduceOnly) closeSent = true;
      else openSent = true;
      return { status: 'NEW' };
    },
  };

  const guarded = guardUsdmClient(mockClient, guard);

  // First call sets lastResponseAt in this minute
  await guarded.ping();

  // Non-protective call is refused by local ceiling
  await assert.rejects(guarded.placeOrder({ reduceOnly: false }), RestBackoffError);
  assert.equal(openSent, false);

  // Cancel order bypasses ceiling
  const cancelRes = await guarded.cancelOrder();
  assert.equal(cancelled, true);

  // Reduce-only order bypasses ceiling
  const closeRes = await guarded.placeOrder({ reduceOnly: true });
  assert.equal(closeSent, true);
});
